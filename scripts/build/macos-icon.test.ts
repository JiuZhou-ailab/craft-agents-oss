// input: Icon Composer source and the precompiled macOS application icon
// output: Regression checks that artwork fits its canvas and compiled layers match the source
// pos: Native branding guard beside macOS release configuration tests
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const resources = join(import.meta.dir, '../../apps/electron/resources');
const icon = JSON.parse(readFileSync(join(resources, 'icon.icon/icon.json'), 'utf8'));
const layers = icon.groups.flatMap((group: any) => group.layers);
const canvasSize = 1024;

function layerSize(layer: any): number[] {
  const png = readFileSync(join(resources, 'icon.icon/Assets', layer['image-name']));
  const scale = layer.position?.scale ?? 1;
  return [png.readUInt32BE(16) * scale, png.readUInt32BE(20) * scale];
}

test('macOS icon artwork stays inside the 1024px canvas', () => {
  expect(layers.length).toBeGreaterThan(0);
  for (const layer of layers) {
    const size = layerSize(layer);
    const translation = layer.position?.['translation-in-points'] ?? [0, 0];
    for (let axis = 0; axis < 2; axis++) {
      expect(size[axis]).toBeGreaterThan(0);
      expect(size[axis]! + 2 * Math.abs(translation[axis])).toBeLessThanOrEqual(canvasSize);
    }
  }
});

test.skipIf(process.platform !== 'darwin')('packaged Assets.car has current, correctly sized artwork in every appearance', () => {
  const assets = JSON.parse(execFileSync('/usr/bin/assetutil', ['--info', join(resources, 'Assets.car')], { encoding: 'utf8' }));
  const groups = assets.filter((asset: any) => asset.AssetType === 'IconGroup');
  expect(groups.length).toBeGreaterThan(0);
  for (const group of groups) {
    expect(group.Layers.length).toBe(layers.length);
    group.Layers.forEach((compiled: any, index: number) => {
      const size = compiled.LayerSize.split(',').map(Number);
      expect(size).toEqual(layerSize(layers[index]));
      expect(Math.max(...size)).toBeLessThanOrEqual(canvasSize);
    });
  }
});
