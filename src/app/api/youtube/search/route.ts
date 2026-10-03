import { createHash } from 'node:crypto';
import { unstable_cache } from 'next/cache';
import { allowRequest, normalizeQuery, searchYoutube, SearchFailure } from '@/lib/youtube-search';

export const runtime = 'nodejs';
export const maxDuration = 15;
const search = unstable_cache(
  (query: string) => searchYoutube(query, process.env.YOUTUBE_API_KEY ?? ''),
  ['melotint-youtube-search-v1'],
  {revalidate:21600},
);
export async function GET(request: Request) {
  try {
    const query = normalizeQuery(new URL(request.url).searchParams.get('q') ?? '');
    const ip = request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('x-forwarded-for') ?? 'unknown';
    const client = createHash('sha256').update(`${process.env.RATE_LIMIT_SALT ?? ''}:${ip}`).digest('hex');
    if (!allowRequest(client)) return Response.json({error:{code:'rate_limited',message:'Please wait a minute before searching again.'}},{status:429,headers:{'Retry-After':'60','Cache-Control':'no-store'}});
    const items = await search(query.toLowerCase());
    return Response.json({source:'youtube',items},{headers:{'Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff'}});
  } catch(error) {
    const failure = error instanceof SearchFailure ? error : new SearchFailure('unavailable',503,'YouTube search is temporarily unavailable. Try again.');
    return Response.json({error:{code:failure.code,message:failure.message}},{status:failure.status,headers:{'Cache-Control':'no-store'}});
  }
}
