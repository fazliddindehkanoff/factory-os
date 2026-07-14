import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'ru' | 'uz' | 'en';

const STORAGE_KEY = 'factoryos.lang';

export const LANG_LABELS: Record<Lang, string> = {
  ru: 'Рус',
  uz: 'Uzb',
  en: 'Eng',
};

const dict = {
  ru: {
    'nav.home': 'Главная',
    'nav.requests': 'Заявки',
    'nav.approvals': 'Согласования',
    'nav.admin': 'Админ',
    'nav.warehouse': 'Склад',
    'nav.procurement': 'Закупки',
    'nav.menu': 'Меню',
    'screen.detail': 'Заявка',
    'menu.theme': 'Тема',
    'menu.themeDark': 'Тёмная',
    'menu.themeLight': 'Светлая',
    'menu.profile': 'Профиль',
    'menu.language': 'Язык',
    'menu.logout': 'Выйти',
    'common.cancel': 'Отмена',
    'common.confirm': 'Подтвердить',
    'common.save': 'Сохранить',
    'common.close': 'Закрыть',
    'common.loading': '…',
    'proc.assignee': 'Снабженец',
    'proc.selectAssignee': 'Выберите снабженца…',
    'proc.noAssignees': 'Нет пользователей с правами снабжения',
    'proc.itemPrices': 'Цены по позициям',
    'proc.unitPrice': 'Цена за 1',
    'proc.selectSupplier': '— выберите поставщика —',
    'proc.supplierManual': 'или поставщик вручную',
    'proc.supplier': 'Поставщик',
    'proc.nds': 'НДС 12%',
    'proc.paymentType': 'Тип оплаты',
    'proc.selectPaymentType': 'Выберите тип оплаты…',
    'proc.total': 'Итого',
    'proc.leadTime': 'Срок поставки (необязательно)',
    'proc.leadTimePlaceholder': 'напр. 10 дней',
    'proc.chooseQuotation': 'Выберите КП поставщика',
    'proc.addQuotationFirst': 'Сначала добавьте хотя бы одно КП.',
    'proc.deliveryTerm': 'срок',
    'reject.reason': 'Причина отклонения',
    'reject.selectReason': 'Выберите причину…',
    'reject.other': 'Другое…',
    'reject.commentPlaceholder': 'Укажите причину',
    'common.comment': 'Комментарий',
    'common.commentPlaceholder': 'Причина / комментарий',
    'action.approve': 'Одобрить',
    'action.reject': 'Отклонить',
    'action.returnRevision': 'Вернуть на доработку',
    'action.addQuotation': 'Добавить предложение',
    'action.approvePrice': 'Отправить предложение',
    'action.whNext': 'Далее',
    'action.receiveFull': 'Подтвердить приёмку',
    'action.placeOrder': 'Оформить заказ',
  },
  uz: {
    'nav.home': 'Asosiy',
    'nav.requests': 'Arizalar',
    'nav.approvals': 'Tasdiqlar',
    'nav.admin': 'Admin',
    'nav.warehouse': 'Ombor',
    'nav.procurement': 'Xaridlar',
    'nav.menu': 'Menyu',
    'screen.detail': 'Ariza',
    'menu.theme': 'Mavzu',
    'menu.themeDark': 'Qorong‘i',
    'menu.themeLight': 'Yorug‘',
    'menu.profile': 'Profil',
    'menu.language': 'Til',
    'menu.logout': 'Chiqish',
    'common.cancel': 'Bekor qilish',
    'common.confirm': 'Tasdiqlash',
    'common.save': 'Saqlash',
    'common.close': 'Yopish',
    'common.loading': '…',
    'proc.assignee': 'Ta’minotchi',
    'proc.selectAssignee': 'Ta’minotchini tanlang…',
    'proc.noAssignees': 'Ta’minot huquqiga ega foydalanuvchilar yo‘q',
    'proc.itemPrices': 'Pozitsiyalar bo‘yicha narxlar',
    'proc.unitPrice': '1 dona narxi',
    'proc.selectSupplier': '— yetkazib beruvchini tanlang —',
    'proc.supplierManual': 'yoki qo‘lda kiriting',
    'proc.supplier': 'Yetkazib beruvchi',
    'proc.nds': 'NDS 12%',
    'proc.paymentType': 'To‘lov turi',
    'proc.selectPaymentType': 'To‘lov turini tanlang…',
    'proc.total': 'Jami',
    'proc.leadTime': 'Yetkazish muddati (ixtiyoriy)',
    'proc.leadTimePlaceholder': 'masalan, 10 kun',
    'proc.chooseQuotation': 'Yetkazib beruvchi taklifini tanlang',
    'proc.addQuotationFirst': 'Avval kamida bitta taklif qo‘shing.',
    'proc.deliveryTerm': 'muddat',
    'reject.reason': 'Rad etish sababi',
    'reject.selectReason': 'Sababni tanlang…',
    'reject.other': 'Boshqa…',
    'reject.commentPlaceholder': 'Sababni kiriting',
    'common.comment': 'Izoh',
    'common.commentPlaceholder': 'Sabab / izoh',
    'action.approve': 'Tasdiqlash',
    'action.reject': 'Rad etish',
    'action.returnRevision': 'Qayta ishlashga qaytarish',
    'action.addQuotation': 'Taklif qo‘shish',
    'action.approvePrice': 'Taklifni yuborish',
    'action.whNext': 'Davom etish',
    'action.receiveFull': 'Qabulni tasdiqlash',
    'action.placeOrder': 'Buyurtmani rasmiylashtirish',
  },
  en: {
    'nav.home': 'Home',
    'nav.requests': 'Requests',
    'nav.approvals': 'Approvals',
    'nav.admin': 'Admin',
    'nav.warehouse': 'Warehouse',
    'nav.procurement': 'Purchasing',
    'nav.menu': 'Menu',
    'screen.detail': 'Request',
    'menu.theme': 'Theme',
    'menu.themeDark': 'Dark',
    'menu.themeLight': 'Light',
    'menu.profile': 'Profile',
    'menu.language': 'Language',
    'menu.logout': 'Log out',
    'common.cancel': 'Cancel',
    'common.confirm': 'Confirm',
    'common.save': 'Save',
    'common.close': 'Close',
    'common.loading': '…',
    'proc.assignee': 'Procurement user',
    'proc.selectAssignee': 'Choose procurement user…',
    'proc.noAssignees': 'No users with procurement permissions',
    'proc.itemPrices': 'Prices by item',
    'proc.unitPrice': 'Unit price',
    'proc.selectSupplier': '— choose supplier —',
    'proc.supplierManual': 'or enter supplier manually',
    'proc.supplier': 'Supplier',
    'proc.nds': 'VAT 12%',
    'proc.paymentType': 'Payment type',
    'proc.selectPaymentType': 'Choose payment type…',
    'proc.total': 'Total',
    'proc.leadTime': 'Delivery term (optional)',
    'proc.leadTimePlaceholder': 'e.g. 10 days',
    'proc.chooseQuotation': 'Choose supplier offer',
    'proc.addQuotationFirst': 'Add at least one offer first.',
    'proc.deliveryTerm': 'term',
    'reject.reason': 'Rejection reason',
    'reject.selectReason': 'Choose reason…',
    'reject.other': 'Other…',
    'reject.commentPlaceholder': 'Enter reason',
    'common.comment': 'Comment',
    'common.commentPlaceholder': 'Reason / comment',
    'action.approve': 'Approve',
    'action.reject': 'Reject',
    'action.returnRevision': 'Return for revision',
    'action.addQuotation': 'Add offer',
    'action.approvePrice': 'Send offer',
    'action.whNext': 'Continue',
    'action.receiveFull': 'Confirm receiving',
    'action.placeOrder': 'Place order',
  },
} as const;

export type I18nKey = keyof typeof dict.ru;

interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: I18nKey) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function initialLang(): Lang {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'uz' || stored === 'ru' || stored === 'en') return stored;
  const browser = navigator.language.toLowerCase();
  if (browser.startsWith('uz')) return 'uz';
  if (browser.startsWith('en')) return 'en';
  return 'ru';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = useCallback((next: Lang) => {
    localStorage.setItem(STORAGE_KEY, next);
    setLangState(next);
  }, []);
  const value = useMemo<I18nValue>(() => ({
    lang,
    setLang,
    t: (key) => dict[lang][key] ?? dict.ru[key] ?? key,
  }), [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}
