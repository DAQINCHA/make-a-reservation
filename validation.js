'use strict';
/** 服务端字段、权限、预约与图片头校验。 */
const COLORS = 'violet blue orange green rose slate crimson amber lime emerald teal cyan sky indigo plum fuchsia coral sand'.split(' ');
const ENTITIES = ['rooms', 'people', 'bookings'];
const BASE_COLUMNS = {
  bookings: ['name', 'roomId', 'personId', 'time', 'status', 'note'],
  rooms: ['name', 'code', 'status', 'recent', 'kind', 'area', 'location', 'equipment', 'note'],
  people: ['name', 'role', 'team', 'email', 'phone', 'note'],
};
const ENTITY_FIELDS = {
  rooms: ['code', 'kind', 'area', 'location', 'equipment', 'note', 'color'],
  people: ['role', 'team', 'email', 'phone', 'note', 'color'],
  bookings: ['roomId', 'personId', 'start', 'end', 'note'],
};
const ROW_LIMITS = { rooms: 500, people: 2000, bookings: 5000 };
const MAX_AVATAR = 3 * 1024 * 1024;
const TIMESTAMP = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?Z$/;

class Invalid extends Error {
  constructor(message = '数据格式错误') {
    super(message);
    this.name = 'Invalid';
  }
}

function must(condition, message = '数据格式错误') {
  if (!condition) throw new Invalid(message);
}

/** 按 Unicode 码点计数，与 Python 的 len(str) 一致。 */
function length(value) {
  let total = 0;
  for (const ignored of value) total += 1;
  return total;
}

function string(value, maximum = 200, minimum = 0) {
  must(typeof value === 'string' && length(value) >= minimum && length(value) <= maximum);
  return value;
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 返回毫秒时间戳，语义与 datetime.fromisoformat(value).timestamp() 对齐。 */
function timestamp(value) {
  must(typeof value === 'string' && TIMESTAMP.test(value));
  const match = TIMESTAMP.exec(value);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
    throw new Invalid('日期格式错误');
  }
  const fraction = match[7] ? Number('0.' + match[7]) * 1000 : 0;
  return Date.UTC(year, month - 1, day, hour, minute, second) + fraction;
}

/** 与 Python float() 对齐的宽松数字解析，便于兼容历史数据。 */
function number(value) {
  const text = String(value).trim();
  if (!text) return 0;
  const plain = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text.replace(/_/g, ''));
  if (plain) return Number(text.replace(/_/g, ''));
  const lower = text.toLowerCase().replace(/^[+-]/, '');
  if (lower === 'inf' || lower === 'infinity') return text.startsWith('-') ? -Infinity : Infinity;
  return NaN;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (!a || !b || typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const keys = Object.keys(a);
  const other = Object.keys(b);
  if (keys.length !== other.length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

function schema(data) {
  must(plainObject(data));
  const result = {};
  for (const key of ENTITIES) {
    const rows = data[key];
    must(Array.isArray(rows) && rows.length <= ROW_LIMITS[key]);
    result[key] = [];
    for (const row of rows) {
      must(plainObject(row));
      const item = { id: string(row.id, 100, 1), name: string(row.name, 100, 1).trim() };
      must(!!item.name, '请填写名称');
      const extra = row.extra;
      must(plainObject(extra) && Object.keys(extra).length <= 40, '自定义字段过多');
      item.extra = {};
      for (const [name, value] of Object.entries(extra)) item.extra[name] = string(value, 2000);
      for (const field of ENTITY_FIELDS[key]) {
        item[field] = string(row[field], field === 'note' || field === 'equipment' ? 2000 : field === 'area' ? 20 : 200);
      }
      if (key === 'people' || key === 'rooms') must(COLORS.includes(item.color));
      if (key === 'people') {
        must(!item.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email), '邮箱格式不正确');
        if ('avatar' in row) {
          must(Number.isInteger(row.avatar) && row.avatar >= 0);
          item.avatar = row.avatar;
        }
      }
      if (key === 'rooms' && 'blocked' in row) {
        must(typeof row.blocked === 'boolean');
        item.blocked = row.blocked;
      }
      if (key === 'bookings') {
        must(!row.cancelled, '取消预约请删除记录');
        timestamp(item.start);
        timestamp(item.end);
      }
      result[key].push(item);
    }
  }
  for (const section of ['fields', 'hidden']) {
    must(plainObject(data[section]));
    result[section] = {};
    for (const key of ENTITIES) {
      const values = data[section][key];
      must(Array.isArray(values) && values.length <= (section === 'fields' ? 30 : 50));
      if (section === 'hidden') {
        result[section][key] = values.map((value) => string(value));
      } else {
        result[section][key] = [];
        for (const field of values) {
          must(plainObject(field) && ['text', 'number', 'date'].includes(field.type));
          result[section][key].push({ id: string(field.id, 200, 1), name: string(field.name, 200, 1), type: field.type });
        }
      }
    }
  }
  if ('columnOrder' in data) {
    const orders = data.columnOrder;
    must(plainObject(orders));
    result.columnOrder = {};
    for (const key of ENTITIES) {
      const values = orders[key] === undefined ? [] : orders[key];
      must(Array.isArray(values) && values.length <= 50);
      const ids = values.map((value) => string(value, 200, 1));
      const allowed = new Set([...BASE_COLUMNS[key], ...result.fields[key].map((field) => field.id)]);
      must(new Set(ids).size === ids.length && ids.every((id) => allowed.has(id)), '表格列顺序无效');
      result.columnOrder[key] = ids;
    }
  }
  if ('bookingOrder' in data) {
    must(data.bookingOrder === 'auto' || data.bookingOrder === 'manual');
    result.bookingOrder = data.bookingOrder;
  }
  return result;
}

function authorize(next, previous, user) {
  if (user.role === 'admin') return;
  const pid = user.personId;
  for (const key of ENTITIES) {
    const oldIds = previous[key].map((row) => row.id);
    const newIds = next[key].map((row) => row.id);
    const oldSet = new Set(oldIds);
    const newSet = new Set(newIds);
    const kept = oldIds.filter((id) => newSet.has(id));
    const after = newIds.filter((id) => oldSet.has(id));
    if (kept.length !== after.length || kept.some((id, index) => id !== after[index])) {
      return key === 'bookings' ? '只有管理员可以调整预约顺序' : '只有管理员可以调整卡片顺序';
    }
  }
  if (!deepEqual(next.rooms, previous.rooms)) return '只有管理员可以修改摄影间信息';
  const nextOthers = next.people.filter((row) => row.id !== pid);
  const oldOthers = previous.people.filter((row) => row.id !== pid);
  if (!deepEqual(nextOthers, oldOthers)) return '只有管理员可以修改其他人员信息';
  if (next.people.some((row) => row.id === pid) !== previous.people.some((row) => row.id === pid)) {
    return '只有管理员可以新增或删除人员';
  }
  if (!deepEqual(next.fields, previous.fields) || !deepEqual(next.hidden, previous.hidden)) return '只有管理员可以修改字段设置';
  if (!deepEqual(next.columnOrder, previous.columnOrder)) return '只有管理员可以修改表格列顺序';
  if ((next.bookingOrder || 'auto') !== (previous.bookingOrder || 'auto')) return '只有管理员可以调整预约顺序';
  const before = new Map(previous.bookings.map((row) => [row.id, row]));
  const after = new Map(next.bookings.map((row) => [row.id, row]));
  for (const [id, booking] of after) {
    const old = before.get(id);
    if (!old && booking.personId !== pid) return '普通用户只能为自己创建预约';
    if (old && !deepEqual(old, booking)) {
      if (old.personId !== pid) return '普通用户只能在自己的预约里调整记录';
      if (old.personId !== booking.personId) return '只有管理员可以更换预约人';
    }
  }
  for (const [id, booking] of before) if (!after.has(id) && booking.personId !== pid) return '普通用户只能在自己的预约里调整记录';
}

function validate(data, previous) {
  for (const entity of ENTITIES) {
    const rows = data[entity];
    const fields = data.fields[entity];
    must(new Set(rows.map((row) => row.id)).size === rows.length, '记录编号不能重复');
    must(new Set(fields.map((field) => field.id)).size === fields.length, '字段编号不能重复');
    for (const row of rows) {
      for (const field of fields) {
        const value = row.extra[field.id];
        if (value && field.type === 'number') must(Number.isFinite(number(value)), `「${field.name}」需要填写数字`);
        if (value && field.type === 'date') must(/^\d{4}-\d{2}-\d{2}$/.test(value), `「${field.name}」需要填写日期`);
      }
    }
  }
  for (const room of data.rooms) {
    if (room.area) must(Number.isFinite(number(room.area)) && number(room.area) >= 0, '摄影间面积必须为非负数');
  }
  const rooms = new Map(data.rooms.map((room) => [room.id, room]));
  const people = new Set(data.people.map((person) => person.id));
  const old = new Map(previous.bookings.map((booking) => [booking.id, booking]));
  for (const booking of data.bookings) {
    must(rooms.has(booking.roomId), '请先移除关联预约，再删除摄影间');
    must(people.has(booking.personId), '请先移除关联预约，再删除人员');
    must(timestamp(booking.end) > timestamp(booking.start), '结束日期不能早于开始日期');
    const room = rooms.get(booking.roomId);
    if (room.blocked) {
      const original = old.get(booking.id);
      const unchanged =
        original &&
        original.roomId === booking.roomId &&
        original.personId === booking.personId &&
        timestamp(original.start) === timestamp(booking.start) &&
        timestamp(original.end) === timestamp(booking.end);
      must(unchanged, `「${room.name}」已屏蔽，不可新增或调整预约，请选择其他摄影间或先解除屏蔽`);
    }
  }
  const latest = new Map();
  const ordered = data.bookings.slice().sort((a, b) => timestamp(a.start) - timestamp(b.start));
  for (const booking of ordered) {
    const until = latest.has(booking.roomId) ? latest.get(booking.roomId) : -Infinity;
    must(until <= timestamp(booking.start), `「${rooms.get(booking.roomId).name}」在该时段已有预约，请调整时间`);
    latest.set(booking.roomId, timestamp(booking.end));
  }
}

function imageInfo(bytes) {
  const at = (offset, size = 2, little = false) => {
    let value = 0;
    for (let index = 0; index < size; index += 1) {
      const position = little ? offset + size - 1 - index : offset + index;
      value = value * 256 + (bytes[position] || 0);
    }
    return value;
  };
  const slice = (start, end) => bytes.subarray(start, end);
  const equals = (start, end, text) => Buffer.compare(slice(start, end), Buffer.from(text, 'latin1')) === 0;
  let mime = null;
  let width = null;
  let height = null;
  if (bytes.length >= 24 && equals(0, 8, '\x89PNG\r\n\x1a\n') && equals(12, 16, 'IHDR')) {
    mime = 'image/png';
    width = at(16, 4);
    height = at(20, 4);
  } else if (bytes.length >= 10 && (equals(0, 6, 'GIF87a') || equals(0, 6, 'GIF89a'))) {
    mime = 'image/gif';
    width = at(6, 2, true);
    height = at(8, 2, true);
  } else if (bytes.length >= 16 && equals(0, 4, 'RIFF') && equals(8, 12, 'WEBP')) {
    mime = 'image/webp';
    if (equals(12, 16, 'VP8 ') && bytes.length >= 30) {
      width = at(26, 2, true) & 0x3fff;
      height = at(28, 2, true) & 0x3fff;
    } else if (equals(12, 16, 'VP8L') && bytes.length >= 25) {
      const bits = at(21, 4, true);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    } else if (equals(12, 16, 'VP8X') && bytes.length >= 30) {
      width = at(24, 3, true) + 1;
      height = at(27, 3, true) + 1;
    }
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 <= bytes.length) {
      if (bytes[offset] !== 255) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 255) {
        offset += 1;
        continue;
      }
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2;
        continue;
      }
      if (marker === 0xda) break;
      const size = at(offset + 2);
      if (size < 2) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        mime = 'image/jpeg';
        height = at(offset + 5);
        width = at(offset + 7);
        break;
      }
      offset += 2 + size;
    }
  }
  return width && height ? { mime, width, height } : null;
}

module.exports = { MAX_AVATAR, Invalid, schema, authorize, validate, imageInfo };
