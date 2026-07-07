/**
 * Детектор тупиков (QA-прогон 2026-07-07, класс «ошибки модели состояний»).
 *
 * Дедлок бизнес-процесса = состояние, из которого ни у кого нет продвигающего
 * действия (кейс шага 10: после отзыва select_supplier у снабженца повторный
 * procurement-шаг встал намертво). Эти инварианты ловят такой класс на уровне
 * РЕЕСТРА, до всякого UI:
 *
 *  1. у каждого step kind есть хотя бы одно НЕ-reject продвигающее действие;
 *  2. каждое такое действие доступно хотя бы одной системной роли по праву —
 *     право, которого нет ни у кого, равно отсутствию действия;
 *  3. procurement особый: продвигающие действия «select_supplier» (до выбора)
 *     и «mark_purchased» (после выбора) должны покрывать ОБЕ фазы шага —
 *     удаление любого из них возвращает дедлок.
 */
import { describe, it, expect } from 'vitest';
import { STEP_KIND_ACTIONS, STEP_KINDS } from './step-kinds.js';
import { SYSTEM_ROLES } from '../rbac/system-roles.js';

const allRolePerms = new Set(SYSTEM_ROLES.flatMap((r) => r.permissions));

describe('инварианты реестра шагов — отсутствие тупиков', () => {
  it('у каждого вида шага есть продвигающее не-reject действие', () => {
    for (const kind of STEP_KINDS) {
      const advancing = STEP_KIND_ACTIONS[kind].filter((a) => a.advance && !a.reject && !a.revision);
      expect(advancing.length, `step kind «${kind}» без продвигающего действия — дедлок`).toBeGreaterThan(0);
    }
  });

  it('каждое продвигающее действие покрыто правом хотя бы одной системной роли', () => {
    for (const kind of STEP_KINDS) {
      for (const a of STEP_KIND_ACTIONS[kind]) {
        if (!a.advance || a.reject || a.revision) continue;
        expect(
          allRolePerms.has(a.perm),
          `действие «${kind}.${a.action}» требует право «${a.perm}», которого нет ни у одной системной роли — мёртвое действие`,
        ).toBe(true);
      }
    }
  });

  it('procurement покрывает обе фазы: до выбора поставщика и после', () => {
    const acts = STEP_KIND_ACTIONS.procurement;
    // Фаза 1 (поставщик не выбран): продвигает действие БЕЗ needsSelectedQuote.
    expect(acts.some((a) => a.advance && !a.reject && !a.revision && !a.needsSelectedQuote)).toBe(true);
    // Фаза 2 (поставщик выбран): продвигает действие с needsSelectedQuote,
    // доступное по праву СБОРЩИКА КП (не только select_supplier-держателю) —
    // иначе возвращается дедлок шага 10.
    const phase2 = acts.find((a) => a.advance && !a.reject && !a.revision && a.needsSelectedQuote);
    expect(phase2, 'нет продвигающего действия для повторного шага закупки').toBeTruthy();
    const rolesWithQuote = SYSTEM_ROLES.filter((r) => r.permissions.includes(phase2!.perm)).map((r) => r.code);
    expect(rolesWithQuote, `право «${phase2!.perm}» должно быть у снабженческих ролей`).toContain('procurement_manager');
  });

  it('close доступен автору: право requests.create у роли заявителя', () => {
    const close = STEP_KIND_ACTIONS.close.find((a) => a.advance);
    expect(close?.requesterOnly).toBe(true);
    const requester = SYSTEM_ROLES.find((r) => r.code === 'requester');
    expect(requester?.permissions).toContain(close!.perm);
  });
});
