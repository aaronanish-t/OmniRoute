import test from "node:test";
import assert from "node:assert/strict";

const sidebarVisibility = await import("../../src/shared/constants/sidebarVisibility.ts");

const {
  SIDEBAR_SECTIONS,
  PROTECTED_SIDEBAR_ITEM_IDS,
  getSectionToggleableItemIds,
  isSidebarSectionVisible,
  toggleSidebarSectionHidden,
} = sidebarVisibility as {
  SIDEBAR_SECTIONS: { id: string; children: readonly unknown[] }[];
  PROTECTED_SIDEBAR_ITEM_IDS: ReadonlySet<string>;
  getSectionToggleableItemIds: (section: { children: readonly unknown[] }) => string[];
  isSidebarSectionVisible: (
    section: { children: readonly unknown[] },
    hiddenItems: readonly string[]
  ) => boolean;
  toggleSidebarSectionHidden: (
    hiddenItems: readonly string[],
    section: { children: readonly unknown[] },
    show: boolean
  ) => string[];
};

function sectionById(id: string) {
  const section = SIDEBAR_SECTIONS.find((s) => s.id === id);
  assert.ok(section, `section ${id} must exist`);
  return section;
}

// ─── getSectionToggleableItemIds ─────────────────────────────────────────────

test("getSectionToggleableItemIds flattens group children into item ids", () => {
  const ids = getSectionToggleableItemIds(sectionById("omni-proxy"));
  assert.ok(ids.includes("endpoints"));
  assert.ok(ids.includes("context-caveman"), "items nested in groups must be included");
});

test("getSectionToggleableItemIds excludes protected items", () => {
  const ids = getSectionToggleableItemIds(sectionById("omni-proxy"));
  assert.ok(ids.includes("proxy") === false, "proxy is protected and must not be toggleable");
  const configIds = getSectionToggleableItemIds(sectionById("configuration"));
  assert.ok(
    configIds.includes("settings-sidebar") === false,
    "settings-sidebar is protected and must not be toggleable"
  );
});

test("getSectionToggleableItemIds returns valid hideable ids only", () => {
  const sidebarVisibilityFull = sidebarVisibility as {
    HIDEABLE_SIDEBAR_ITEM_IDS: readonly string[];
  };
  for (const section of SIDEBAR_SECTIONS) {
    for (const id of getSectionToggleableItemIds(section)) {
      assert.ok(
        sidebarVisibilityFull.HIDEABLE_SIDEBAR_ITEM_IDS.includes(id),
        `${id} in section ${section.id} must be a hideable item id`
      );
    }
  }
});

// ─── isSidebarSectionVisible ─────────────────────────────────────────────────

test("isSidebarSectionVisible is true when nothing is hidden", () => {
  const section = sectionById("analytics");
  assert.equal(isSidebarSectionVisible(section, []), true);
});

test("isSidebarSectionVisible is false when all toggleable items are hidden", () => {
  const section = sectionById("analytics");
  const ids = getSectionToggleableItemIds(section);
  assert.ok(ids.length > 0);
  assert.equal(isSidebarSectionVisible(section, ids), false);
});

test("isSidebarSectionVisible is true for a partially hidden section", () => {
  const section = sectionById("analytics");
  const ids = getSectionToggleableItemIds(section);
  assert.ok(ids.length > 1, "analytics must have more than one toggleable item for this test");
  assert.equal(isSidebarSectionVisible(section, [ids[0]]), true);
});

test("isSidebarSectionVisible is always true for a section with no toggleable items", () => {
  assert.equal(isSidebarSectionVisible({ children: [] }, []), true);
  assert.equal(isSidebarSectionVisible({ children: [] }, ["home"]), true);
});

// ─── toggleSidebarSectionHidden ──────────────────────────────────────────────

test("toggleSidebarSectionHidden hides all toggleable items of the section", () => {
  const section = sectionById("analytics");
  const ids = getSectionToggleableItemIds(section);
  const next = toggleSidebarSectionHidden([], section, false);
  for (const id of ids) {
    assert.ok(next.includes(id), `${id} must become hidden`);
  }
});

test("toggleSidebarSectionHidden does not touch protected items", () => {
  const section = sectionById("omni-proxy");
  const next = toggleSidebarSectionHidden([], section, false);
  for (const id of PROTECTED_SIDEBAR_ITEM_IDS) {
    assert.ok(next.includes(id) === false, `protected ${id} must never be hidden`);
  }
});

test("toggleSidebarSectionHidden preserves hidden items from other sections", () => {
  const analytics = sectionById("analytics");
  const help = sectionById("help");
  const analyticsIds = getSectionToggleableItemIds(analytics);
  const next = toggleSidebarSectionHidden(analyticsIds, help, false);
  // analytics items stay hidden, help items added on top
  for (const id of analyticsIds) {
    assert.ok(next.includes(id), `existing hidden ${id} must be preserved`);
  }
  for (const id of getSectionToggleableItemIds(help)) {
    assert.ok(next.includes(id), `help item ${id} must become hidden`);
  }
});

test("toggleSidebarSectionHidden show removes only this section's items", () => {
  const analytics = sectionById("analytics");
  const help = sectionById("help");
  const helpIds = getSectionToggleableItemIds(help);
  const hidden = [...getSectionToggleableItemIds(analytics), ...helpIds];
  const next = toggleSidebarSectionHidden(hidden, analytics, true);
  for (const id of getSectionToggleableItemIds(analytics)) {
    assert.ok(next.includes(id) === false, `analytics item ${id} must become visible`);
  }
  for (const id of helpIds) {
    assert.ok(next.includes(id), `help item ${id} must stay hidden`);
  }
});

test("toggleSidebarSectionHidden is idempotent", () => {
  const section = sectionById("costs");
  const once = toggleSidebarSectionHidden([], section, false);
  const twice = toggleSidebarSectionHidden(once, section, false);
  assert.deepEqual([...twice].sort(), [...once].sort());
  const shownOnce = toggleSidebarSectionHidden(once, section, true);
  const shownTwice = toggleSidebarSectionHidden(shownOnce, section, true);
  assert.deepEqual([...shownTwice].sort(), [...shownOnce].sort());
});

test("every section has at least one toggleable item (master toggle is usable)", () => {
  for (const section of SIDEBAR_SECTIONS) {
    const ids = getSectionToggleableItemIds(section);
    assert.ok(
      ids.length > 0,
      `section ${section.id} has no toggleable items; the master toggle would be dead UI`
    );
  }
});
