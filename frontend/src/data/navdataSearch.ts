/**
 * Thin client for the /api/navdata/search endpoint (the offline-built SQLite
 * FTS index of airports, heliports and waypoints). Shared by the PAN console
 * autocomplete and CommandHandler's PAN-to-navaid fallback.
 */

export interface NavdataSearchResult {
    kind: 'airport' | 'heliport' | 'waypoint';
    ident: string;
    name: string;
    lat: number;
    lon: number;
    /** IATA code, when known (airports only); empty string otherwise. */
    iata?: string;
}

/**
 * Search the navdata index by identifier/name prefix. Resolves to an empty
 * list when the index is not built or the search fails server-side; rejects
 * only on network-level errors.
 */
export async function searchNavdata(
    query: string,
    limit = 10
): Promise<NavdataSearchResult[]> {
    const resp = await fetch(
        `/api/navdata/search?q=${encodeURIComponent(query)}&limit=${limit}`
    );
    const data = await resp.json();
    if (!data?.success || !Array.isArray(data.results)) return [];
    return data.results as NavdataSearchResult[];
}
