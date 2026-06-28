/** Pure Telegram message builders (no side effects) — easy to unit-test. */
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
