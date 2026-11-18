// U3D encoder + /3D annotation embedding (local 3D equipment palette):
// a mesh written by encodeU3D must decode with the same triangle count, and
// embed3DAnnotation must produce an annotation that find3DAnnotations sees,
// on pages with and without an existing /Annots array.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, PDFName } from 'pdf-lib';

import { encodeU3D } from './u3d-encoder.js';
import { readU3D } from './u3d-reader.js';
import { embed3DAnnotation } from './embed-3d.js';
import { find3DAnnotations } from './pdf-3d.js';

// Unit cube, two colours: 12 triangles.
function cube() {
  const p = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return { triangles: f.map(([a, b, c], i) => ({ a: p[a], b: p[b], c: p[c], color: i < 6 ? '#ff0000' : '#0000ff' })), lines: [] };
}

test('encodeU3D output decodes with the same triangle count', () => {
  const scene = readU3D(encodeU3D(cube(), 'Cube'));
  assert.equal(scene.skipped, 0);
  assert.equal(scene.triangles, 12);
});

test('embeds on a page without /Annots and on one that already has them', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([792, 612]);
  pdf.addPage([792, 612]);
  pdf.getPage(1).node.set(PDFName.of('Annots'), pdf.context.obj([]));
  const modelBytes = encodeU3D(cube(), 'Cube');
  for (const pageNumber of [1, 2])
    await embed3DAnnotation(pdf, { pageNumber, rect: [100, 100, 300, 250], modelBytes, format: 'U3D', title: 'Cube' });
  const found = find3DAnnotations(await PDFDocument.load(await pdf.save()));
  assert.deepEqual(found.map(a => [a.page, a.subtype, a.rect]), [[1, 'U3D', [100, 100, 300, 250]], [2, 'U3D', [100, 100, 300, 250]]]);
});

test('rejects a bad page, an empty rectangle and an unknown format', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const modelBytes = encodeU3D(cube(), 'Cube');
  await assert.rejects(embed3DAnnotation(pdf, { pageNumber: 2, rect: [0, 0, 10, 10], modelBytes, format: 'U3D' }), RangeError);
  await assert.rejects(embed3DAnnotation(pdf, { pageNumber: 1, rect: [10, 10, 10, 20], modelBytes, format: 'U3D' }), RangeError);
  await assert.rejects(embed3DAnnotation(pdf, { pageNumber: 1, rect: [0, 0, 10, 10], modelBytes, format: 'OBJ' }), TypeError);
});
