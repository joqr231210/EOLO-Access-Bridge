import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { prepareDahuaFacePhoto } from '../src/dahuaClient.js';

test('normalizes a large portrait for Dahua FaceInfoManager', async () => {
  const original = await sharp({
    create: { width: 2400, height: 3200, channels: 3, background: '#888888' }
  }).png().toBuffer();

  const photo = await prepareDahuaFacePhoto(original);
  const metadata = await sharp(photo).metadata();

  assert.equal(metadata.format, 'jpeg');
  assert.ok(metadata.width >= 150 && metadata.width <= 600);
  assert.ok(metadata.height >= 300 && metadata.height <= 1200);
  assert.ok(photo.length < 100 * 1024);
});
