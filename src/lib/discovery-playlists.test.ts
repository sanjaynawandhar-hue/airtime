import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseDiscoveryPlaylists} from './discovery-playlists';
test('Apple playlists do not require artistName and preserve canonical URLs',()=>{
 const data={feed:{results:[{id:'pl.test',name:'Bollywood Hits',url:'https://music.apple.com/in/playlist/test/pl.test',artworkUrl100:'https://is1-ssl.mzstatic.com/image.jpg'}]}};
 const items=parseDiscoveryPlaylists(data);
 assert.equal(items.length,1);
 assert.equal(items[0].title,'Bollywood Hits');
 assert.equal(items[0].curator,'');
});
test('invalid and foreign playlist links are omitted',()=>{
 assert.deepEqual(parseDiscoveryPlaylists({feed:{results:[{id:'x',name:'Bad',url:'https://example.com'}]}}),[]);
 assert.deepEqual(parseDiscoveryPlaylists(null),[]);
});
