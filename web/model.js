export function project(records) {
  const undone = new Set(records.filter(r => r.type === 'undo').flatMap(r => r.eventIds));
  const active = records.filter(r => !undone.has(r.id));
  const deleted = new Set(records.filter(r => r.type === 'delete').map(r => r.garmentId));
  const washed = new Set(active.filter(r => r.type === 'wash').flatMap(r => r.wearIds));
  return active.filter(r => r.type === 'garment' && !deleted.has(r.id)).map(g => {
    const history = active.filter(r => r.type === 'wear' && r.garmentId === g.id);
    const wears = history.filter(r => !washed.has(r.id));
    return {...g, wears, history, count: wears.reduce((n, r) => n + r.quantity, 0)};
  });
}
export function merge(remote, local) {
  return [...new Map([...remote, ...local].map(r => [r.id, r])).values()];
}

const garmentNames = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});

export function sortGarments(garments, order) {
  const oldest = (a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt);
  const namedFirst = (a, b) => {
    const left = a.name.trim();
    const right = b.name.trim();
    return Number(!left) - Number(!right) || garmentNames.compare(left, right);
  };
  const compare = {
    newest: (a, b) => oldest(b, a),
    least: (a, b) => a.count - b.count,
    most: (a, b) => b.count - a.count,
    name: namedFirst
  };
  const primary = Object.hasOwn(compare, order) ? compare[order] : oldest;
  return [...garments].sort((a, b) => primary(a, b) || oldest(a, b) || a.id.localeCompare(b.id));
}
