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

export const askPhoneMessage = (): string =>
  '📱 Чтобы открыть Factory OS, поделитесь своим номером телефона — нажмите кнопку ниже.\n\nНомер должен совпадать с тем, что указал ваш администратор.';

export const phoneLinkedMessage = (name?: string): string =>
  `✅ ${name ? name + ', номер' : 'Номер'} подтверждён. Открываю доступ...`;

export const phoneNotFoundMessage = (): string =>
  '❌ Этот номер не найден в системе. Обратитесь к администратору, чтобы вас добавили, и повторите /start.';

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

export const returnedToStepMessage = (requestNumber: string, stepName: string, reason: string): string =>
  `↩️ Заявка ${requestNumber} возвращена на этап: ${stepName}.${reason ? `\nПричина: ${reason}` : ''}`;

export const confirmReceiptMessage = (requestNumber: string): string =>
  `📦 Заявка ${requestNumber}: товар передан. Подтвердите получение в приложении.`;

export const closedMessage = (requestNumber: string): string =>
  `✅ Заявка ${requestNumber} закрыта.`;

export const escalationReminderMessage = (requestNumber: string, stepName: string, hours: number): string =>
  `⏰ Заявка ${requestNumber} ждёт на этапе «${stepName}» уже ${hours} ч. Пожалуйста, примите решение.`;

export const escalationOverdueMessage = (requestNumber: string, stepName: string, hours: number): string =>
  `🚨 Заявка ${requestNumber} стоит на этапе «${stepName}» ${hours} ч — вдвое дольше таймаута. Нужно вмешательство.`;

export const digestMessage = (count: number, numbers: string[]): string =>
  `⏳ Ждут вашего решения: ${count} ${plural(count, 'заявка', 'заявки', 'заявок')}.\n${numbers.join(', ')}${count > numbers.length ? '…' : ''}\nОткройте приложение, раздел «Ожидают меня».`;

const plural = (n: number, one: string, few: string, many: string): string => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
