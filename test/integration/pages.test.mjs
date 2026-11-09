// Multi-page rendering on the real my_lcd project. The paged UI is created
// inside the project (as a throwaway component) and removed afterwards, so
// this test exercises the same code path a user would hit: lvglui.json points
// at a UI component that defines ui_page_count/ui_page_name/ui_page_show.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadContext } from '../../core/context.mjs';
import { renderProject } from '../../core/render.mjs';

const PROJECT = 'D:/esps3_test/my_lcd';
const SKIP = fs.existsSync(PROJECT) ? false : `${PROJECT} not found`;

const UI_DIR_REL = 'components/lvglui_pages_it';

const PAGED_UI = {
  'CMakeLists.txt': `idf_component_register(
  SRCS "src/ui.c" "src/ui_pages.c"
  INCLUDE_DIRS "include"
  REQUIRES lvgl__lvgl
)
`,
  'include/ui.h': `#pragma once
#include "lvgl.h"
lv_obj_t *ui_start(lv_obj_t *parent);
`,
  'include/ui_pages.h': `#pragma once
#include "lvgl.h"
int ui_page_count(void);
const char *ui_page_name(int index);
lv_obj_t *ui_page_show(int index, lv_obj_t *parent);
`,
  'src/ui.c': `#include "ui.h"
#include "ui_pages.h"
lv_obj_t *ui_start(lv_obj_t *parent) { return ui_page_show(0, parent); }
`,
  'src/ui_pages.c': `#include "ui_pages.h"

static lv_obj_t *make_page(lv_obj_t *root, uint32_t bg, const char *text)
{
    lv_obj_set_style_bg_color(root, lv_color_hex(bg), 0);
    lv_obj_set_style_bg_opa(root, LV_OPA_COVER, 0);
    lv_obj_t *label = lv_label_create(root);
    lv_label_set_text(label, text);
    lv_obj_center(label);
    lv_obj_set_name(label, text);
    return root;
}

static lv_obj_t *home_create(lv_obj_t *root) { return make_page(root, 0xCC2222, "home"); }
static lv_obj_t *settings_create(lv_obj_t *root) { return make_page(root, 0x2244CC, "settings"); }

static const struct {
    const char *name;
    lv_obj_t *(*create)(lv_obj_t *root);
} s_pages[] = {
    { "home", home_create },
    { "settings", settings_create },
};

int ui_page_count(void) { return (int)(sizeof(s_pages) / sizeof(s_pages[0])); }

const char *ui_page_name(int index)
{
    if(index < 0 || index >= ui_page_count()) return NULL;
    return s_pages[index].name;
}

lv_obj_t *ui_page_show(int index, lv_obj_t *parent)
{
    if(index < 0 || index >= ui_page_count()) return NULL;
    lv_obj_t *root = parent;
    if(root == NULL) root = lv_obj_create(NULL);
    s_pages[index].create(root);
    if(parent == NULL) lv_screen_load(root);
    return root;
}
`,
};

test('multi-page: one PNG per page plus a contact sheet', { skip: SKIP, timeout: 240_000 }, () => {
  const uiDir = path.join(PROJECT, UI_DIR_REL);
  const configFile = path.join(PROJECT, 'lvglui.json');
  const stateDir = path.join(PROJECT, '.lvglui');
  const hadConfig = fs.existsSync(configFile);
  const savedConfig = hadConfig ? fs.readFileSync(configFile) : null;

  try {
    for (const [rel, text] of Object.entries(PAGED_UI)) {
      const file = path.join(uiDir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    fs.writeFileSync(
      configFile,
      `${JSON.stringify({
        schema: 1,
        uiDir: UI_DIR_REL,
        entry: 'ui_start',
        display: { width: 240, height: 320, colorDepth: 16 },
      }, null, 2)}\n`,
    );

    const ctx = loadContext({ projectDir: PROJECT });
    assert.equal(ctx.ok, true, ctx.problems.join('; '));
    assert.equal(ctx.pages.supported, true, ctx.pages.problems.join('; '));

    const all = renderProject(ctx, { allPages: true });
    assert.equal(all.ok, true, all.error?.message ?? 'render failed');
    assert.deepEqual(all.pages.map((page) => page.name), ['home', 'settings']);
    assert.equal(all.pngPath, path.join(ctx.outDir, 'shot-sheet.png'));
    assert.ok(fs.existsSync(all.pngPath), 'contact sheet should exist');
    assert.notEqual(all.pages[0].sha256, all.pages[1].sha256);
    for (const page of all.pages) {
      assert.ok(fs.existsSync(path.join(ctx.outDir, page.png)), `missing ${page.png}`);
      assert.ok(fs.existsSync(path.join(ctx.outDir, page.tree)), `missing ${page.tree}`);
    }
    assert.equal(fs.existsSync(path.join(ctx.outDir, 'shot.png')), false,
      '--all-pages must not also write the single-page shot.png');

    const single = renderProject(ctx, { page: 'settings', rebuild: false });
    assert.equal(single.ok, true, single.error?.message ?? 'render failed');
    assert.equal(single.page, 'settings');
    assert.equal(single.meta.png.sha256, all.pages[1].sha256,
      '--page must render exactly the page that --all-pages rendered');
    assert.equal(single.names.includes('settings'), true);
  } finally {
    fs.rmSync(uiDir, { recursive: true, force: true });
    if (hadConfig) fs.writeFileSync(configFile, savedConfig);
    else fs.rmSync(configFile, { force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});