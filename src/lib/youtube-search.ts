// Server entry point is api/youtube/search. Never import the API key into UI code.
export class SearchFailure extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}
export function normalizeQuery(value: string): string {
  const q = value.trim().replace(/\s+/g, ' ');
  if (q.length < 2 || q.length > 120) throw new SearchFailure('invalid_query',400,'Enter a song or artist name between 2 and 120 characters.');
  return q;
}
export interface YoutubeResult { id: string; title: string; channel: string; thumbnail: string | null }
export async function searchYoutube(query: string, key: string, fetcher: typeof fetch = fetch): Promise<YoutubeResult[]> {
  const q = normalizeQuery(query);
  if (!key) throw new SearchFailure('not_configured',503,'YouTube search is not configured.');
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.search = new URLSearchParams({part:'snippet',type:'video',q,maxResults:'15',order:'relevance',videoEmbeddable:'true',videoSyndicated:'true',regionCode:'IN',safeSearch:'moderate'}).toString();
  let response: Response;
  try {
    response = await fetcher(url, {headers:{'X-Goog-Api-Key':key},signal:AbortSignal.timeout(10000),cache:'no-store'});
  } catch { throw new SearchFailure('unavailable',503,'YouTube search is temporarily unavailable. Try again.'); }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = data?.error?.errors?.[0]?.reason;
    if (['quotaExceeded','dailyLimitExceeded'].includes(reason)) throw new SearchFailure('quota_exceeded',503,'YouTube search has reached its daily limit. Please try later.');
    throw new SearchFailure('unavailable',503,'YouTube search is temporarily unavailable. Try again.');
  }
  if (!Array.isArray(data?.items)) throw new SearchFailure('unavailable',503,'YouTube returned an invalid response. Try again.');
  const results: YoutubeResult[] = [];
  for (const item of data.items) {
    const id = item?.id?.videoId;
    const s = item?.snippet;
    if (typeof id !== 'string' || !/^[\w-]{11}$/.test(id) || typeof s?.title !== 'string') continue;
    const thumbnail = s.thumbnails?.medium?.url ?? s.thumbnails?.default?.url;
    results.push({id,title:s.title,channel:typeof s.channelTitle === 'string' ? s.channelTitle : '',thumbnail:typeof thumbnail === 'string' && thumbnail.startsWith('https://i.ytimg.com/') ? thumbnail : null});
  }
  return results;
}

// Best-effort burst protection per warm instance; Google project quota remains
// the global ceiling. This is not a distributed daily quota reservation.
const clients = new Map<string,{count:number;until:number}>();
export function allowRequest(client: string, now = Date.now()): boolean {
  for (const [key, value] of clients) if (value.until <= now) clients.delete(key);
  const window = clients.get(client);
  if (window) return ++window.count <= 10;
  if (clients.size >= 2000) return false;
  clients.set(client,{count:1,until:now+60000});
  return true;
}
