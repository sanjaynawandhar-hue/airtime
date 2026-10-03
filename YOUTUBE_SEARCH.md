# MeloTint YouTube search

`GET /api/youtube/search?q=Coldplay%20Yellow` returns up to 15 video results:

```json
{"source":"youtube","items":[{"id":"video-id","title":"Video title","channel":"Publisher","thumbnail":"https://i.ytimg.com/..."}]}
```

The production `YOUTUBE_API_KEY` remains server-side. Requests use a header instead of putting the key in URLs. The handler caches normalized queries for six hours, selects embeddable/syndicated videos available in India, and distinguishes upstream failure, quota exhaustion, invalid query, and no matches. Embedding availability can still change after search.

Burst protection allows ten requests per minute per hashed IP per warm instance. It is intentionally best-effort, not a distributed daily budget. Google project quota is the global ceiling shared with other Airtime features. A public rollout should add durable distributed quota reservation or a dedicated project before higher traffic. No raw IP is persisted by the handler.

No database, new Google key, or paid service was created. Search is public and reveals only public YouTube metadata. The app does not receive credentials.

Validation:

- `node --import tsx --test src/lib/youtube-search.test.ts`
- `npx eslint src/lib/youtube-search.ts src/lib/youtube-search.test.ts src/app/api/youtube/search/route.ts`
- `npm run build`

Next.js and matching ESLint configuration were updated to 16.3.8 because the previous version had a critical advisory reported by npm audit. Remaining audit findings are outside this endpoint and require separate dependency maintenance.

## Discovery

`GET /api/music/discovery` supplies India YouTube music-chart videos, artist names from Apple's public songs chart, and canonical Apple playlist links. Video details retain the actual YouTube publisher IDs used by search. Non-embeddable videos are omitted. Apple playlist parsing allows the documented feed's missing artistName field rather than treating playlist rows as songs.

MeloTint ranks For You and its own daily mixes locally using listening history; no history is uploaded. Apple playlist links open Apple Music. This does not enable MusicKit catalog streaming or Spotify playback.

Additional checks: `node --import tsx --test src/lib/discovery-playlists.test.ts`; live endpoint returns 30 chart videos, 12 artists, and 12 playlists as of 2026-10-04.
