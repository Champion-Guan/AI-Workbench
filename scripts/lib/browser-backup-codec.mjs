// Backup format 1 codec. No logging, network calls or persistence side effects.
function bytesFromBase64(value) {
  // Avoid repeated-group regexes: large image payloads can overflow the regex stack.
  if (typeof value !== 'string' || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) throw new Error('备份二进制编码无效');
  const padding = value.indexOf('=');
  if (padding !== -1 && (padding < value.length - 2 || !['=', '=='].includes(value.slice(padding)))) throw new Error('备份二进制编码无效');
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
function base64FromBytes(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
export function decodeBackupValue(value) {
  const references = new Map();
  function decode(node) {
    if (node === null || ['string', 'boolean', 'number'].includes(typeof node)) return node;
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('备份值格式无效');
    const type = node.$type;
    if (type === 'undefined') return undefined;
    if (type === 'number') return node.negativeZero ? -0 : Number(node.value);
    if (type === 'bigint') return BigInt(node.value);
    if (type === 'ref') {
      if (!references.has(node.id)) throw new Error('备份对象引用无效');
      return references.get(node.id);
    }
    if (!Number.isInteger(node.id) || references.has(node.id)) throw new Error('备份对象编号无效');
    let result;
    switch (type) {
      case 'object': result = {}; break;
      case 'array': result = []; break;
      case 'map': result = new Map(); break;
      case 'set': result = new Set(); break;
      case 'date': result = new Date(node.value); break;
      case 'regexp': result = new RegExp(node.source, node.flags); break;
      case 'blob': case 'file': {
        const bytes = bytesFromBase64(node.base64);
        if (bytes.byteLength !== node.bytes) throw new Error('备份文件长度不一致');
        result = type === 'file' ? new File([bytes], node.name, { type: node.mime, lastModified: node.lastModified }) : new Blob([bytes], { type: node.mime });
        break;
      }
      case 'arraybuffer': result = bytesFromBase64(node.base64).buffer; break;
      case 'typedarray': {
        const kinds = { Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView };
        if (!Object.hasOwn(kinds, node.kind)) throw new Error('备份数组类型无效');
        result = new kinds[node.kind](bytesFromBase64(node.base64).buffer); break;
      }
      default: throw new Error('备份对象类型不支持');
    }
    references.set(node.id, result);
    if (type === 'object') for (const [key, item] of node.entries) {
      if (typeof key !== 'string') throw new Error('备份属性名无效');
      Object.defineProperty(result, key, { value: decode(item), enumerable: true, writable: true, configurable: true });
    }
    if (type === 'array') for (const item of node.values) result.push(decode(item));
    if (type === 'set') for (const item of node.values) result.add(decode(item));
    if (type === 'map') for (const [key, item] of node.entries) result.set(decode(key), decode(item));
    return result;
  }
  return decode(value);
}
export async function encodeBackupValue(value) {
  const references = new Map();
  async function encode(node) {
    if (node === null || ['string', 'boolean'].includes(typeof node)) return node;
    if (typeof node === 'number') return Number.isFinite(node) && !Object.is(node, -0) ? node : { $type: 'number', value: String(node), negativeZero: Object.is(node, -0) };
    if (node === undefined) return { $type: 'undefined' };
    if (typeof node === 'bigint') return { $type: 'bigint', value: String(node) };
    if (typeof node !== 'object') throw new Error('无法备份该值类型');
    if (references.has(node)) return { $type: 'ref', id: references.get(node) };
    const id = references.size + 1;
    references.set(node, id);
    if (node instanceof Blob) {
      const bytes = new Uint8Array(await node.arrayBuffer());
      const file = typeof File !== 'undefined' && node instanceof File;
      return { $type: file ? 'file' : 'blob', id, mime: node.type,
        ...(file ? { name: node.name, lastModified: node.lastModified } : {}), bytes: bytes.length, base64: base64FromBytes(bytes) };
    }
    if (node instanceof Date) return { $type: 'date', id, value: node.toISOString() };
    if (node instanceof RegExp) return { $type: 'regexp', id, source: node.source, flags: node.flags };
    if (node instanceof ArrayBuffer) return { $type: 'arraybuffer', id, base64: base64FromBytes(new Uint8Array(node)) };
    if (ArrayBuffer.isView(node)) return { $type: 'typedarray', id, kind: node.constructor.name, base64: base64FromBytes(new Uint8Array(node.buffer, node.byteOffset, node.byteLength)) };
    if (node instanceof Map) {
      const entries = [];
      for (const [key, item] of node) entries.push([await encode(key), await encode(item)]);
      return { $type: 'map', id, entries };
    }
    if (node instanceof Set || Array.isArray(node)) {
      const values = [];
      for (const item of node) values.push(await encode(item));
      return { $type: Array.isArray(node) ? 'array' : 'set', id, values };
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(node))) throw new Error('无法备份未知对象类型');
    const entries = [];
    for (const key of Object.keys(node)) entries.push([key, await encode(node[key])]);
    return { $type: 'object', id, entries };
  }
  return encode(value);
}
