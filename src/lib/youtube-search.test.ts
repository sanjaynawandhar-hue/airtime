import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchYoutube, SearchFailure, normalizeQuery, allowRequest } from './youtube-search';

test('validates queries before spending quota', () => {
  assert.equal(normalizeQuery('  Arijit   Singh '), 'Arijit Singh');
  assert.throws(() => normalizeQuery(' '), SearchFailure);
  assert.throws(() => normalizeQuery('a'.repeat(121)), SearchFailure);
});
test('uses embeddable video search and strips upstream metadata', async () => {
  const items = await searchYoutube('Tum Hi Ho', 'private-key', async (url, init) => {
    const u = new URL(String(url));
    assert.equal(u.searchParams.get('videoEmbeddable'), 'true');
    assert.equal(u.searchParams.get('type'), 'video');
    assert.equal(u.searchParams.get('key'), null);
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'private-key');
    return Response.json({items:[{id:{videoId:'M7lc1UVf-VE'},snippet:{title:'Test song',channelTitle:'Channel',description:'omit',thumbnails:{medium:{url:'https://i.ytimg.com/vi/M7lc1UVf-VE/mqdefault.jpg'}}}}, {id:{videoId:'bad'}}]});
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Test song');
  assert.equal('description' in items[0], false);
});
test('quota error stays distinct from empty search and never exposes upstream text', async () => {
  await assert.rejects(searchYoutube('song','private-key',async()=>Response.json({error:{errors:[{reason:'quotaExceeded'}],message:'private-key'}},{status:403})), (e: unknown) => e instanceof SearchFailure && e.code === 'quota_exceeded' && !e.message.includes('private-key'));
  assert.deepEqual(await searchYoutube('song','key',async()=>Response.json({items:[]})), []);
});
test('rate guard expires windows', () => {
  for(let i=0;i<10;i++) assert.equal(allowRequest('test-client',1000),true);
  assert.equal(allowRequest('test-client',1001),false);
  assert.equal(allowRequest('test-client',61001),true);
});
