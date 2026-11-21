const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "fe-de-crystal", "index.html"), "utf8");

test("standalone Fe de Crystal route contains the approved album presentation", () => {
  assert.match(html, /<html lang="es">/);
  assert.match(html, /Escucha nuestro álbum en tu plataforma favorita\./);
  assert.match(html, /id="album-title">Fe de Crystal</);
  assert.match(html, /\/assets\/fe-de-crystal-album\.webp/);
  assert.match(html, /\/assets\/fe-de-crystal-banner\.webp/);
  assert.equal(fs.existsSync(path.join(root, "assets", "fe-de-crystal-album.webp")), true);
  assert.equal(fs.existsSync(path.join(root, "assets", "fe-de-crystal-banner.webp")), true);
});

test("music platform buttons use every supplied album destination", () => {
  for (const destination of [
    "https://open.spotify.com/artist/4q8xarh52TxQpZmIzYrwDz?si=64JThihOSqa4e3gV8rLmPw",
    "https://music.apple.com/us/artist/fe-de-crystal/6831714373",
    "https://music.youtube.com/playlist?list=OLAK5uy_nJ2D33vVv6qx-c9TKk2zlm3dIunFjMGms&amp;si=2N-C5MXK-mePjD_6",
    "https://music.amazon.com/albums/B0HQQ25D99?ref=dm_sh_b472-e203-14b9-982d-bb9e7",
    "https://www.pandora.com/artist/fe-de-crystal/fe-de-crystal/ALpxh232K5lr922"
  ]) assert.match(html, new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("video links and channel call to action are complete and safely external", () => {
  for (const destination of [
    "https://youtu.be/6AsxpjJh5AQ",
    "https://youtu.be/IA2YYAb5I3I",
    "https://youtu.be/Fc_3bleRyHs",
    "https://www.youtube.com/@FeDeCrystalOficial"
  ]) assert.match(html, new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, />Ver nuestros videos</);
  const externalLinks = [...html.matchAll(/<a\s[^>]*target="_blank"[^>]*>/g)];
  assert.equal(externalLinks.length, 9);
  for (const [tag] of externalLinks) assert.match(tag, /rel="noopener noreferrer"/);
});

test("page includes mobile and reduced-motion presentation rules", () => {
  assert.match(html, /@media \(max-width: 520px\)/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(html, /grid-template-columns: 1fr/);
});
