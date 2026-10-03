import { parseDiscoveryPlaylists } from '@/lib/discovery-playlists';
import { fetchAppleFeed } from '@/lib/providers/appleMusic';
import { keys } from '@/lib/core/config';
import { youtubeProvider } from '@/lib/providers/youtube';

export const runtime = 'nodejs';
export const maxDuration = 30;
export async function GET() {
  const [videos, songs, playlists] = await Promise.all([
    youtubeProvider.fetchTrending({country:'IN',limit:50}),
    fetchAppleFeed('IN','songs',50),
    fetch('https://rss.marketingtools.apple.com/api/v2/in/music/most-played/12/playlists.json',{signal:AbortSignal.timeout(10000),next:{revalidate:1800}}).then(async response => response.ok ? parseDiscoveryPlaylists(await response.json()) : []).catch(()=>[]),
  ]);
  // Hydrate actual publishers: the chart provider's artist label may have
  // been parsed from a title and is not a reliable channel identity.
  let trending: {id:string;title:string;channel:string;channelId:string;thumbnail:string|null}[] = [];
  if (videos.length && keys.youtube) {
    try {
      const url = new URL('https://www.googleapis.com/youtube/v3/videos');
      url.search = new URLSearchParams({part:'snippet,status',id:videos.map(v=>v.sourceId).join(',')}).toString();
      const response = await fetch(url,{headers:{'X-Goog-Api-Key':keys.youtube},signal:AbortSignal.timeout(10000),next:{revalidate:1800}});
      if (response.ok) {
        const data = await response.json();
        if(Array.isArray(data?.items)) {
          trending = data.items.filter((v: {id?:string;snippet?:{title?:string;channelTitle?:string;channelId?:string};status?:{embeddable?:boolean}})=> typeof v.id === 'string' && /^[\w-]{11}$/.test(v.id) && typeof v.snippet?.title === 'string' && typeof v.snippet?.channelId === 'string' && v.status?.embeddable === true).map((v: {id:string;snippet:{title:string;channelTitle:string;channelId:string;thumbnails?:{medium?:{url?:string}}}})=>({id:v.id,title:v.snippet.title,channel:v.snippet.channelTitle,channelId:v.snippet.channelId,thumbnail:v.snippet.thumbnails?.medium?.url ?? null}));
          const positions = new Map(videos.map((v,i)=>[v.sourceId,i]));
          trending.sort((a,b)=>(positions.get(a.id)??999)-(positions.get(b.id)??999));
        }
      }
    } catch { /* Return an explicit unavailable chart, never invented data. */ }
  }
  const artists = [...new Set(songs.map(s => s.artist).filter(Boolean))].slice(0,12);
  return Response.json({
    region:'IN',
    // Use source ordering as chart ordering. No invented popularity scores.
    trending,
    artists,
    playlists,
    availability:{youtube:trending.length > 0,appleArtists:artists.length > 0,applePlaylists:playlists.length > 0},
  },{headers:{'Cache-Control':trending.length > 0 && playlists.length > 0 && artists.length > 0 ? 'public, s-maxage=1800, stale-while-revalidate=3600' : 'no-store'}});
}
