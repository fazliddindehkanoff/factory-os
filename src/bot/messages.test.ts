import { describe, it, expect } from 'vitest';
import {
  startMessage,
  helpMessage,
  approvedStageMessage,
  approvedFinalMessage,
  rejectedMessage,
} from './messages.js';

describe('bot messages', () => {
  it('builds a start message with and without a name', () => {
    expect(startMessage('Иван')).toContain('Иван');
    expect(startMessage()).toContain('Добро пожаловать');
  });
  it('builds approval messages with the request number', () => {
    expect(approvedStageMessage('REQ-2026-00001')).toContain('REQ-2026-00001');
    expect(approvedFinalMessage('REQ-2026-00001')).toContain('полностью согласована');
  });
  it('builds a rejection message with the reason', () => {
    const m = rejectedMessage('REQ-2026-00002', 'нет бюджета');
    expect(m).toContain('REQ-2026-00002');
    expect(m).toContain('нет бюджета');
  });
  it('help message mentions /start', () => {
    expect(helpMessage()).toContain('/start');
  });
});
