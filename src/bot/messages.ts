/** Pure Telegram message builders (no side effects) — easy to unit-test. */

/**
 * Escape special chars for Telegram MarkdownV2.
 * Currently messages are sent as plain text (no parse_mode), so this helper
 * is not yet applied — but it future-proofs against injection when we switch
 * to MarkdownV2.
 */
export function esc(s: string): string {
  return s.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
export const startMessage = (name?: string): string =>
  `👋 ${name ? name + ', добро' : 'Добро'} пожаловать в Factory OS.\n\nНажмите кнопку ниже, чтобы открыть приложение.`;

export const helpMessage = (): string =>
  'Factory OS — заявки и согласования.\n/start — открыть приложение.';

export const approvedStageMessage = (requestNumber: string): string =>
  `✅ Ваша заявка ${requestNumber} согласована на текущем этапе и ушла дальше по цепочке.`;

export const approvedFinalMessage = (requestNumber: string): string =>
  `🎉 Заявка ${requestNumber} полностью согласована.`;

export const rejectedMessage = (requestNumber: string, reason: string): string =>
  `❌ Заявка ${requestNumber} отклонена.\nПричина: ${reason}`;

export const needsRevisionMessage = (requestNumber: string, reason: string): string =>
  `✏️ Заявка ${requestNumber} возвращена вам на доработку.${reason ? `\nПричина: ${reason}` : ''}\nИсправьте её и нажмите «Отправить повторно».`;

export const newRequestForApproverMessage = (requestNumber: string, title: string, stepName: string): string =>
  `📋 Новая заявка ${requestNumber} ожидает вашего действия.\n${title ? `Тема: ${title}\n` : ''}Этап: ${stepName}`;

export const requestMovedToStepMessage = (requestNumber: string, stepName: string): string =>
  `🔄 Заявка ${requestNumber} перешла на этап: ${stepName}.`;
