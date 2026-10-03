export function parseDiscoveryPlaylists(data: unknown) {
  const feed = data as {feed?:{results?:unknown[]}} | null;
  if (!Array.isArray(feed?.feed?.results)) return [];
  return feed.feed.results.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const p = item as Record<string,unknown>;
    if (typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.url !== 'string' || !p.url.startsWith('https://music.apple.com/')) return [];
    return [{id:p.id,title:p.name,curator:typeof p.artistName === 'string' ? p.artistName : '',url:p.url,artwork:typeof p.artworkUrl100 === 'string' && p.artworkUrl100.startsWith('https://') ? p.artworkUrl100 : null}];
  });
}
