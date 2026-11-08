import { readTextFile, writeTextFile } from "./fs.js";
import { githubBlobUrl, githubCommitRangeUrl, githubCommitUrl } from "./source.js";
import type {
  ApiParameterSpec,
  ApiRouteSpec,
  ApiSpec,
  HttpMethod,
  ParameterLocation,
  SourceLocation,
  ValueType,
} from "./types.js";

interface DiffSummary {
  readonly changed: boolean;
  readonly addedRoutes: readonly string[];
  readonly removedRoutes: readonly string[];
  readonly changedRoutes: readonly RouteChange[];
}

interface RouteChange {
  readonly routeKey: string;
  readonly addedParams: readonly string[];
  readonly removedParams: readonly string[];
  readonly changedParamTypes: readonly ParamTypeChange[];
}

interface ParamTypeChange {
  readonly parameterKey: string;
  readonly previousType: ValueType | undefined;
  readonly nextType: ValueType | undefined;
}

interface ComparableRoute {
  readonly routeKey: string;
  readonly params: ReadonlyMap<string, ValueType | undefined>;
}

export async function runSemanticDiff(options: {
  readonly previousPath: string;
  readonly nextPath: string;
  readonly jsonOutputPath: string | undefined;
  readonly markdownOutputPath: string | undefined;
}): Promise<DiffSummary> {
  const previous = await readSpec(options.previousPath);
  const next = await readSpec(options.nextPath);
  const summary = diffSpecs(previous, next);

  if (options.jsonOutputPath !== undefined) {
    await writeTextFile(options.jsonOutputPath, `${JSON.stringify(summary, null, 2)}\n`);
  }
  if (options.markdownOutputPath !== undefined) {
    await writeTextFile(options.markdownOutputPath, renderMarkdown(summary, previous, next));
  }

  return summary;
}

async function readSpec(filePath: string): Promise<ApiSpec> {
  const sourceText = await readTextFile(filePath);
  return JSON.parse(sourceText) as ApiSpec;
}

function diffSpecs(previous: ApiSpec, next: ApiSpec): DiffSummary {
  const previousRoutes = indexRoutes(previous.routes);
  const nextRoutes = indexRoutes(next.routes);

  const addedRoutes = sortedKeysDifference(nextRoutes, previousRoutes);
  const removedRoutes = sortedKeysDifference(previousRoutes, nextRoutes);

  const changedRoutes = [...previousRoutes.keys()]
    .filter((routeKey) => nextRoutes.has(routeKey))
    .map((routeKey) => diffRoute(previousRoutes.get(routeKey), nextRoutes.get(routeKey)))
    .filter((route): route is RouteChange => route !== undefined)
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey));

  return {
    changed:
      addedRoutes.length > 0 ||
      removedRoutes.length > 0 ||
      changedRoutes.length > 0,
    addedRoutes,
    removedRoutes,
    changedRoutes,
  };
}

function indexRoutes(routes: readonly ApiRouteSpec[]): ReadonlyMap<string, ComparableRoute> {
  return new Map(
    routes.map((route) => {
      const routeKey = buildRouteKey(route.method, route.pathTemplate);
      return [
        routeKey,
        {
          routeKey,
          params: new Map([
            ...route.pathParams.map((parameter) => [buildParameterKey("path", parameter), parameter.valueType] as const),
            ...route.queryParams.map((parameter) => [buildParameterKey("query", parameter), parameter.valueType] as const),
            ...route.bodyParams.map((parameter) => [buildParameterKey("body", parameter), parameter.valueType] as const),
          ]),
        },
      ] as const;
    }),
  );
}

function diffRoute(
  previous: ComparableRoute | undefined,
  next: ComparableRoute | undefined,
): RouteChange | undefined {
  if (previous === undefined || next === undefined) {
    return undefined;
  }

  const addedParams = sortedKeysDifference(next.params, previous.params);
  const removedParams = sortedKeysDifference(previous.params, next.params);
  const changedParamTypes = [...previous.params.keys()]
    .filter((parameterKey) => next.params.has(parameterKey))
    .map((parameterKey) => {
      const previousType = previous.params.get(parameterKey);
      const nextType = next.params.get(parameterKey);
      if (previousType === nextType) {
        return undefined;
      }
      return {
        parameterKey,
        previousType,
        nextType,
      } satisfies ParamTypeChange;
    })
    .filter((change): change is ParamTypeChange => change !== undefined)
    .sort((left, right) => left.parameterKey.localeCompare(right.parameterKey));

  if (
    addedParams.length === 0 &&
    removedParams.length === 0 &&
    changedParamTypes.length === 0
  ) {
    return undefined;
  }

  return {
    routeKey: previous.routeKey,
    addedParams,
    removedParams,
    changedParamTypes,
  };
}

function sortedKeysDifference<T>(
  left: ReadonlyMap<string, T>,
  right: ReadonlyMap<string, T>,
): readonly string[] {
  return [...left.keys()]
    .filter((key) => !right.has(key))
    .sort((a, b) => a.localeCompare(b));
}

function buildRouteKey(method: HttpMethod, pathTemplate: string): string {
  return `${method} ${pathTemplate}`;
}

function buildParameterKey(location: ParameterLocation, parameter: ApiParameterSpec): string {
  return `${location}:${parameter.canonicalPath}`;
}

function renderMarkdown(summary: DiffSummary, previous: ApiSpec, next: ApiSpec): string {
  if (!summary.changed) {
    return [
      "# Typesense API extraction changed",
      "",
      "The committed extraction diff does not include any API-shape changes that require `openapi.yml` updates.",
      "",
    ].join("\n");
  }

  const previousSources = new SourceLinks(previous);
  const nextSources = new SourceLinks(next);
  const lines = [
    renderSourceRange(previous, next),
    "",
    "Check each change against its linked source, then update `openapi.yml` on this branch. Parameter names are usually right, but types are inferred, and the server reading a parameter doesn't make it public.",
    "",
  ];

  if (summary.addedRoutes.length > 0) {
    lines.push("## Added routes", "");
    lines.push(...summary.addedRoutes.map((routeKey) => `- ${routeKey}${nextSources.forRoute(routeKey)}`), "");
  }

  if (summary.removedRoutes.length > 0) {
    lines.push("## Removed routes", "");
    lines.push(...summary.removedRoutes.map((routeKey) => `- ${routeKey}${previousSources.forRoute(routeKey)}`), "");
  }

  if (summary.changedRoutes.length > 0) {
    lines.push("## Changed routes", "");
    summary.changedRoutes.forEach((route) => {
      lines.push(`### ${route.routeKey}`, "");
      lines.push(
        ...route.addedParams.map(
          (parameter) => `- Added parameter: ${parameter}${nextSources.forParameter(route.routeKey, parameter)}`,
        ),
        ...route.removedParams.map(
          (parameter) => `- Removed parameter: ${parameter}${previousSources.forParameter(route.routeKey, parameter)}`,
        ),
        ...route.changedParamTypes.map(
          (change) =>
            `- Changed parameter type: ${change.parameterKey} (${formatType(change.previousType)} -> ${formatType(change.nextType)})${nextSources.forParameter(route.routeKey, change.parameterKey)}`,
        ),
      );
      lines.push("");
    });
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Which Typesense commits the changes came from. */
function renderSourceRange(previous: ApiSpec, next: ApiSpec): string {
  const branch = next.sourceBranch === undefined ? "Typesense" : `Typesense \`${next.sourceBranch}\``;
  if (next.sourceCommit === undefined) {
    return `${branch}: source commit unknown.`;
  }
  const nextShort = shortCommit(next.sourceCommit);
  if (previous.sourceCommit === undefined) {
    return `${branch}: [\`${nextShort}\`](${githubCommitUrl(next.sourceCommit)})`;
  }
  if (previous.sourceCommit === next.sourceCommit) {
    return `${branch}: still at [\`${nextShort}\`](${githubCommitUrl(next.sourceCommit)}), so these changes come from the extractor or its config, not from Typesense.`;
  }
  const range = `${shortCommit(previous.sourceCommit)}...${nextShort}`;
  return `${branch}: [\`${range}\`](${githubCommitRangeUrl(previous.sourceCommit, next.sourceCommit)})`;
}

function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

/** Renders ` ([src/file.cpp:12](url))` for the source of a route or parameter. */
class SourceLinks {
  readonly #commit: string | undefined;
  readonly #routes: ReadonlyMap<string, ApiRouteSpec>;

  constructor(spec: ApiSpec) {
    this.#commit = spec.sourceCommit;
    this.#routes = new Map(spec.routes.map((route) => [buildRouteKey(route.method, route.pathTemplate), route]));
  }

  forRoute(routeKey: string): string {
    return this.#render(this.#routes.get(routeKey)?.source);
  }

  forParameter(routeKey: string, parameterKey: string): string {
    const route = this.#routes.get(routeKey);
    if (route === undefined) {
      return "";
    }
    const parameter = [...route.pathParams, ...route.queryParams, ...route.bodyParams].find(
      (candidate) => buildParameterKey(candidate.location, candidate) === parameterKey,
    );
    return this.#render(parameter?.sources[0]);
  }

  #render(source: SourceLocation | undefined): string {
    const url = source === undefined ? undefined : githubBlobUrl(source.filePath, source.line, this.#commit);
    if (source === undefined || url === undefined) {
      return "";
    }
    const filePath = new URL(url).pathname.split("/").slice(5).join("/");
    return ` ([${filePath}:${String(source.line)}](${url}))`;
  }
}

function formatType(valueType: ValueType | undefined): string {
  return valueType ?? "undefined";
}
