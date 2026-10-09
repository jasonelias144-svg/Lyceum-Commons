/**
 * Unlisted rename (H29 L1): rooms saved before the rename are retitled on restore.
 * Only exact default titles change; custom titles and non-Human rooms are left alone.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const persist = require('../src/persist');

function room(id, title, parent_id = null) {
  return {
    id,
    title,
    parent_id,
    merged_into: null,
    stream: 'human',
    participants: 'H:H',
    format: 'board',
    created_at: new Date().toISOString(),
    roster: [],
    members: {},
    messages: [],
    merge_history: [],
  };
}

describe('Unlisted rename: legacy "Private room" titles on restore', () => {
  it('retitles default titles and leaves custom ones', () => {
    const snap = persist.serialize();
    snap.human.rooms = [
      room('hrm_old', 'Private room'),
      room('hrm_br1', 'Branch of Private room', 'hrm_old'),
      room('hrm_br2', 'Branch of Branch of Private room', 'hrm_br1'),
      room('hrm_custom', 'Private room', 'hrm_old'),
      room('hrm_named', 'Private room talk'),
      room('opn_like', 'Private room'),
    ];
    persist.restore(snap);
    assert.equal(store.getRoom('hrm_old').title, 'Unlisted room');
    assert.equal(store.getRoom('hrm_br1').title, 'Branch of Unlisted room');
    assert.equal(store.getRoom('hrm_br2').title, 'Branch of Branch of Unlisted room');
    assert.equal(store.getRoom('hrm_custom').title, 'Private room');
    assert.equal(store.getRoom('hrm_named').title, 'Private room talk');
    assert.equal(store.getRoom('opn_like').title, 'Private room');
    store.clearAll();
  });
});
