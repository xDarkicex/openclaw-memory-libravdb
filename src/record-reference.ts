import type { SearchResult } from "@xdarkicex/libravdb-contracts";

/** Local provenance from the request header, never from stored record metadata. */
export type RoutedSearchResult = SearchResult & { sourceTenant?: string };
const RECORD_PREFIX = "libravdb://record/";

export function encodeRecordReference(tenant: string, collection: string, id: string): string {
  return RECORD_PREFIX + [tenant, collection, id].map(encodeURIComponent).join("/");
}

export function decodeRecordReference(value: string): { tenant: string; collection: string; id: string } | undefined {
  if (!value.startsWith(RECORD_PREFIX)) return undefined;
  const parts = value.slice(RECORD_PREFIX.length).split("/");
  if (parts.length !== 3) throw new Error("Invalid LibraVDB record reference");
  try {
    const [tenant, collection, id] = parts.map(decodeURIComponent);
    if (!id) throw new Error("Missing record ID");
    return { tenant: tenant!, collection: collection!, id };
  } catch {
    throw new Error("Invalid LibraVDB record reference");
  }
}

function resultCollection(item: SearchResult): string {
  try {
    const meta = JSON.parse(new TextDecoder().decode(item.metadataJson)) as { collection?: unknown };
    if (typeof meta?.collection === "string") return meta.collection;
  } catch { /* Older records may omit metadata. */ }
  return "memory";
}

export function searchResultKey(item: RoutedSearchResult, tenant = item.sourceTenant): string {
  return JSON.stringify([tenant ?? null, resultCollection(item), item.id]);
}

export function searchResultPath(item: RoutedSearchResult): string {
  const collection = resultCollection(item);
  return item.sourceTenant === undefined
    ? `${encodeURIComponent(collection)}::${encodeURIComponent(item.id)}`
    : encodeRecordReference(item.sourceTenant, collection, item.id);
}
