// Add an ISO 32000 /3D annotation containing an existing U3D or PRC stream.
// The optional poster is a Form XObject, so ordinary PDF viewers show a
// non-interactive fallback. This operation is intentionally in-memory: callers
// must explicitly save a NEW PDF copy; it never writes to the source path.
import { PDFName, PDFArray, PDFString } from 'pdf-lib';

function validRect(rect) {
  return Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite)
    && rect[2] > rect[0] && rect[3] > rect[1];
}

/**
 * @param {import('pdf-lib').PDFDocument} pdf
 * @param {{pageNumber:number, rect:number[], modelBytes:Uint8Array,
 *   format:'U3D'|'PRC', posterPng?:Uint8Array, title?:string}} input
 */
export async function embed3DAnnotation(pdf, input) {
  const { pageNumber, rect, modelBytes, format, posterPng, title = '3D Equipment' } = input;
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.getPageCount()) throw new RangeError('Invalid PDF page');
  if (!validRect(rect)) throw new RangeError('3D annotation rectangle must have positive width and height');
  if (format !== 'U3D' && format !== 'PRC') throw new TypeError('Only U3D and PRC model streams are supported');
  if (!(modelBytes instanceof Uint8Array) || modelBytes.length < 24 || modelBytes.length > 20_000_000) throw new RangeError('Invalid or oversized 3D model stream');
  if (posterPng && (!(posterPng instanceof Uint8Array) || posterPng.length > 8_000_000)) throw new RangeError('Invalid or oversized PNG poster');
  const ctx = pdf.context;
  const stream = ctx.flateStream(modelBytes, { Type: '3D', Subtype: format });
  const streamRef = ctx.register(stream);
  const ann = { Type: 'Annot', Subtype: '3D', Rect: rect, '3DD': streamRef, NM: PDFString.of(`opds-3d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`), Contents: PDFString.of(title.slice(0, 100)), F: 4 };
  if (posterPng) {
    const png = await pdf.embedPng(posterPng);
    const width = rect[2] - rect[0], height = rect[3] - rect[1];
    const appearance = ctx.flateStream(new TextEncoder().encode(`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`), {
      Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, width, height],
      Resources: { XObject: { Im0: png.ref } },
    });
    const appRef = ctx.register(appearance);
    ann.AP = { N: appRef };
  }
  const annotRef = ctx.register(ctx.obj(ann));
  const page = pdf.getPage(pageNumber - 1);
  // lookupMaybe: a page without markups has no /Annots entry; lookup() would throw.
  let arr = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!arr) { arr = ctx.obj([]); page.node.set(PDFName.of('Annots'), arr); }
  arr.push(annotRef);
  return { pageNumber, format, rect: rect.slice(), title, byteLength: modelBytes.length };
}
