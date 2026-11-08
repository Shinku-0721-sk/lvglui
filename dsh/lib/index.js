import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(here, '..', 'skills', 'lvglui');
const skillPath = path.join(skillDir, 'SKILL.md');

const DESCRIPTION =
  '用 lvglui 在 ESP-IDF 6.x + LVGL 9.x 工程里编写/调整 UI：渲染截图、读控件树、只改 UI 层，业务逻辑走 ui_port。';
const WHEN_TO_USE =
  '当用户要在 ESP32 LVGL 工程里新增/修改页面、布局、控件、字体，或要看当前 UI 的 PC 预览时。';

function definition(content) {
  return {
    name: 'lvglui',
    description: DESCRIPTION,
    whenToUse: WHEN_TO_USE,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: 'lvglui',
    resourceBase: { kind: 'directory', path: skillDir },
    path: skillPath,
    content,
  };
}

export const name = 'lvglui';
export const inject = ['skills'];

export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.skills.registerProvider(() => ({
      name: 'lvglui',
      async list() {
        return [
          {
            name: 'lvglui',
            description: DESCRIPTION,
            whenToUse: WHEN_TO_USE,
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'bundled',
            provider: 'lvglui',
            rank: 10,
            locator: { path: skillPath, directory: skillDir },
            resourceBase: { kind: 'directory', path: skillDir },
            path: skillPath,
          },
        ];
      },
      async get() {
        const raw = fs.readFileSync(skillPath, 'utf8');
        const content = raw.replace(/^---[\s\S]*?---\s*/, '').trim();
        return definition(content);
      },
    }));
    return dispose;
  });
}