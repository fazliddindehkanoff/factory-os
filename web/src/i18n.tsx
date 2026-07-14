import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

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

const literalDict: Record<string, { uz: string; en: string }> = {
  'Загрузка…': { uz: 'Yuklanmoqda…', en: 'Loading…' },
  'Главная': { uz: 'Asosiy', en: 'Home' },
  'Заявки': { uz: 'Arizalar', en: 'Requests' },
  'Согласования': { uz: 'Tasdiqlar', en: 'Approvals' },
  'Склад': { uz: 'Ombor', en: 'Warehouse' },
  'Закупки': { uz: 'Xaridlar', en: 'Purchasing' },
  'Меню': { uz: 'Menyu', en: 'Menu' },
  'Админ': { uz: 'Admin', en: 'Admin' },
  'Администрирование': { uz: 'Admin boshqaruvi', en: 'Administration' },
  'Новая заявка': { uz: 'Yangi ariza', en: 'New request' },
  'Все заявки': { uz: 'Barcha arizalar', en: 'All requests' },
  'Мои заявки': { uz: 'Mening arizalarim', en: 'My requests' },
  'Ожидают меня': { uz: 'Meni kutmoqda', en: 'Waiting for me' },
  'Активных всего': { uz: 'Jami aktiv', en: 'Total active' },
  'Созданные мной': { uz: 'Men yaratganlar', en: 'Created by me' },
  'Последние события': { uz: 'Oxirgi voqealar', en: 'Recent events' },
  'Ждут моего решения': { uz: 'Qarorimni kutmoqda', en: 'Awaiting my decision' },
  'Тема': { uz: 'Mavzu', en: 'Theme' },
  'Тема оформления': { uz: 'Ko‘rinish mavzusi', en: 'Appearance theme' },
  'Тёмная': { uz: 'Qorong‘i', en: 'Dark' },
  'Светлая': { uz: 'Yorug‘', en: 'Light' },
  'Профиль': { uz: 'Profil', en: 'Profile' },
  'Редактировать профиль': { uz: 'Profilni tahrirlash', en: 'Edit profile' },
  'Язык': { uz: 'Til', en: 'Language' },
  'Выйти': { uz: 'Chiqish', en: 'Log out' },
  'Закрыть': { uz: 'Yopish', en: 'Close' },
  'Отмена': { uz: 'Bekor qilish', en: 'Cancel' },
  'Назад': { uz: 'Orqaga', en: 'Back' },
  'Далее': { uz: 'Davom etish', en: 'Next' },
  'Сохранить': { uz: 'Saqlash', en: 'Save' },
  'Сохранено': { uz: 'Saqlandi', en: 'Saved' },
  'Создать заявку': { uz: 'Ariza yaratish', en: 'Create request' },
  'Изменить': { uz: 'Tahrirlash', en: 'Edit' },
  'Удалить': { uz: 'O‘chirish', en: 'Delete' },
  'Удалить заявку': { uz: 'Arizani o‘chirish', en: 'Delete request' },
  'Изменить заявку': { uz: 'Arizani tahrirlash', en: 'Edit request' },
  'Тип заявки': { uz: 'Ariza turi', en: 'Request type' },
  'Отдел': { uz: 'Bo‘lim', en: 'Department' },
  'Отделы': { uz: 'Bo‘limlar', en: 'Departments' },
  'Склады': { uz: 'Omborlar', en: 'Warehouses' },
  'Заводы': { uz: 'Zavodlar', en: 'Factories' },
  'Пользователи': { uz: 'Foydalanuvchilar', en: 'Users' },
  'Роли': { uz: 'Rollar', en: 'Roles' },
  'Права': { uz: 'Huquqlar', en: 'Permissions' },
  'Структура': { uz: 'Tuzilma', en: 'Structure' },
  'Люди': { uz: 'Odamlar', en: 'People' },
  'Форма': { uz: 'Forma', en: 'Form' },
  'Материалы': { uz: 'Materiallar', en: 'Materials' },
  'Аудит': { uz: 'Audit', en: 'Audit' },
  'Настройки': { uz: 'Sozlamalar', en: 'Settings' },
  'Обзор': { uz: 'Umumiy ko‘rinish', en: 'Overview' },
  'Активные заявки': { uz: 'Aktiv arizalar', en: 'Active requests' },
  'Позиции': { uz: 'Pozitsiyalar', en: 'Items' },
  'Количество:': { uz: 'Miqdor:', en: 'Quantity:' },
  'Поставщик:': { uz: 'Yetkazib beruvchi:', en: 'Supplier:' },
  'Условия:': { uz: 'Shartlar:', en: 'Terms:' },
  'Цена за 1:': { uz: '1 dona narxi:', en: 'Unit price:' },
  'Сумма:': { uz: 'Summa:', en: 'Amount:' },
  'Процесс согласования': { uz: 'Tasdiqlash jarayoni', en: 'Approval process' },
  'Примечание': { uz: 'Izoh', en: 'Note' },
  'Дополнительно': { uz: 'Qo‘shimcha', en: 'Additional' },
  'Коммерческие предложения': { uz: 'Tijorat takliflari', en: 'Commercial offers' },
  'выбран': { uz: 'tanlangan', en: 'selected' },
  'Вложения': { uz: 'Biriktirmalar', en: 'Attachments' },
  '+ Файл': { uz: '+ Fayl', en: '+ File' },
  'Скачать': { uz: 'Yuklab olish', en: 'Download' },
  'Статус': { uz: 'Holat', en: 'Status' },
  'Автор': { uz: 'Muallif', en: 'Author' },
  'Завод': { uz: 'Zavod', en: 'Factory' },
  'Объект': { uz: 'Obyekt', en: 'Object' },
  'Место закупа': { uz: 'Xarid joyi', en: 'Purchase origin' },
  'Ответственный': { uz: 'Mas’ul', en: 'Responsible' },
  'Статус снабжения': { uz: 'Ta’minot holati', en: 'Procurement status' },
  'Нужно к': { uz: 'Kerak bo‘lgan sana', en: 'Needed by' },
  'Местный': { uz: 'Mahalliy', en: 'Local' },
  'Импорт': { uz: 'Import', en: 'Import' },
  'Я начал': { uz: 'Boshladim', en: 'Started' },
  'В процессе оплаты': { uz: 'To‘lov jarayonida', en: 'Payment in progress' },
  'В процессе доставки': { uz: 'Yetkazish jarayonida', en: 'Delivery in progress' },
  'Заказ оформлен': { uz: 'Buyurtma rasmiylashtirildi', en: 'Order placed' },
  'Проблема': { uz: 'Muammo', en: 'Problem' },
  'Создана': { uz: 'Yaratildi', en: 'Created' },
  'Отклонено': { uz: 'Rad etildi', en: 'Rejected' },
  'Отменено': { uz: 'Bekor qilindi', en: 'Cancelled' },
  'Согласовано': { uz: 'Tasdiqlandi', en: 'Approved' },
  'Текущий этап · ожидает': { uz: 'Joriy bosqich · kutmoqda', en: 'Current step · waiting' },
  'Ожидает': { uz: 'Kutmoqda', en: 'Waiting' },
  'В наличии': { uz: 'Mavjud', en: 'In stock' },
  'Нет': { uz: 'Yo‘q', en: 'No' },
  'Нет — в закупку': { uz: 'Yo‘q — xaridga', en: 'No — to purchasing' },
  'Принято:': { uz: 'Qabul qilindi:', en: 'Received:' },
  'Материал': { uz: 'Material', en: 'Material' },
  'Количество': { uz: 'Miqdor', en: 'Quantity' },
  'Причина': { uz: 'Sabab', en: 'Reason' },
  'Остатки': { uz: 'Qoldiqlar', en: 'Balances' },
  'Приёмка': { uz: 'Qabul', en: 'Receiving' },
  'Выдача': { uz: 'Berish', en: 'Issue' },
  'Журнал': { uz: 'Jurnal', en: 'Journal' },
  'Приход': { uz: 'Kirim', en: 'Income' },
  'Расход': { uz: 'Chiqim', en: 'Outcome' },
  'Коррекция': { uz: 'Tuzatish', en: 'Correction' },
  'Ничего не найдено': { uz: 'Hech narsa topilmadi', en: 'Nothing found' },
  'Здесь пока пусто': { uz: 'Hozircha bo‘sh', en: 'Nothing here yet' },
  'Нет остатков на складе': { uz: 'Omborda qoldiq yo‘q', en: 'No warehouse balances' },
  'Нет записей в журнале': { uz: 'Jurnalda yozuvlar yo‘q', en: 'No journal records' },
  'Принять на склад': { uz: 'Omborga qabul qilish', en: 'Receive to warehouse' },
  'Выдать со склада': { uz: 'Ombordan berish', en: 'Issue from warehouse' },
  'Отправка...': { uz: 'Yuborilmoqda...', en: 'Sending...' },
  'Поставщики': { uz: 'Yetkazib beruvchilar', en: 'Suppliers' },
  'Финансы': { uz: 'Moliya', en: 'Finance' },
  'Добавить': { uz: 'Qo‘shish', en: 'Add' },
  'Добавить человека': { uz: 'Odam qo‘shish', en: 'Add person' },
  'Имя': { uz: 'Ism', en: 'Name' },
  'Назначить': { uz: 'Tayinlash', en: 'Assign' },
  'Назначить права': { uz: 'Huquq tayinlash', en: 'Assign permissions' },
  'Снять': { uz: 'Olib tashlash', en: 'Remove' },
  'Сбросить PIN': { uz: 'PINni tiklash', en: 'Reset PIN' },
  'Удалить пользователя': { uz: 'Foydalanuvchini o‘chirish', en: 'Delete user' },
  'Готово': { uz: 'Tayyor', en: 'Done' },
  'Название': { uz: 'Nomi', en: 'Name' },
  'Без прав': { uz: 'Huquqsiz', en: 'No permissions' },
  'Весь холдинг': { uz: 'Butun holding', en: 'Whole holding' },
  'Не задано': { uz: 'Belgilanmagan', en: 'Not set' },
  'Сохранить настройки': { uz: 'Sozlamalarni saqlash', en: 'Save settings' },
  'Название организации': { uz: 'Tashkilot nomi', en: 'Organization name' },
  'Валюта': { uz: 'Valyuta', en: 'Currency' },
  'Тема по умолчанию': { uz: 'Standart mavzu', en: 'Default theme' },
  'Типы оплаты для снабжения': { uz: 'Ta’minot uchun to‘lov turlari', en: 'Procurement payment types' },
  'Тип оплаты': { uz: 'To‘lov turi', en: 'Payment type' },
  'Выберите тип оплаты…': { uz: 'To‘lov turini tanlang…', en: 'Choose payment type…' },
  'Снабженец': { uz: 'Ta’minotchi', en: 'Procurement user' },
  'Выберите снабженца…': { uz: 'Ta’minotchini tanlang…', en: 'Choose procurement user…' },
  'Цены по позициям': { uz: 'Pozitsiyalar bo‘yicha narxlar', en: 'Prices by item' },
  'Цена за 1': { uz: '1 dona narxi', en: 'Unit price' },
  'Поставщик': { uz: 'Yetkazib beruvchi', en: 'Supplier' },
  'НДС 12%': { uz: 'NDS 12%', en: 'VAT 12%' },
  'Итого': { uz: 'Jami', en: 'Total' },
  'Срок поставки (необязательно)': { uz: 'Yetkazish muddati (ixtiyoriy)', en: 'Delivery term (optional)' },
  'Выберите КП поставщика': { uz: 'Yetkazib beruvchi taklifini tanlang', en: 'Choose supplier offer' },
  'Сначала добавьте хотя бы одно КП.': { uz: 'Avval kamida bitta taklif qo‘shing.', en: 'Add at least one offer first.' },
  'Причина отклонения': { uz: 'Rad etish sababi', en: 'Rejection reason' },
  'Выберите причину…': { uz: 'Sababni tanlang…', en: 'Choose reason…' },
  'Другое…': { uz: 'Boshqa…', en: 'Other…' },
  'Комментарий': { uz: 'Izoh', en: 'Comment' },
  'Подтвердить': { uz: 'Tasdiqlash', en: 'Confirm' },
  'Одобрить': { uz: 'Tasdiqlash', en: 'Approve' },
  'Отклонить': { uz: 'Rad etish', en: 'Reject' },
  'Вернуть на доработку': { uz: 'Qayta ishlashga qaytarish', en: 'Return for revision' },
  'Добавить предложение': { uz: 'Taklif qo‘shish', en: 'Add offer' },
  'Отправить предложение': { uz: 'Taklifni yuborish', en: 'Send offer' },
  'Оформить заказ': { uz: 'Buyurtmani rasmiylashtirish', en: 'Place order' },
  'Уведомления': { uz: 'Bildirishnomalar', en: 'Notifications' },
  '← Назад': { uz: '← Orqaga', en: '← Back' },
  '+ Завод': { uz: '+ Zavod', en: '+ Factory' },
  '+ Отдел': { uz: '+ Bo‘lim', en: '+ Department' },
  '+ Склад': { uz: '+ Ombor', en: '+ Warehouse' },
  '+ Права': { uz: '+ Huquq', en: '+ Permission' },
  'Без завода (холдинг)': { uz: 'Zavodsiz (holding)', en: 'No factory (holding)' },
  'Нет отделов': { uz: 'Bo‘limlar yo‘q', en: 'No departments' },
  'Нет складов': { uz: 'Omborlar yo‘q', en: 'No warehouses' },
  'Нет заводов в этом холдинге.': { uz: 'Bu holdingda zavodlar yo‘q.', en: 'No factories in this holding.' },
  'В отделе нет сотрудников.': { uz: 'Bo‘limda xodimlar yo‘q.', en: 'No employees in this department.' },
  'Никого не найдено.': { uz: 'Hech kim topilmadi.', en: 'No people found.' },
  'Прав нет.': { uz: 'Huquqlar yo‘q.', en: 'No permissions.' },
  'Заявка создана': { uz: 'Ariza yaratildi', en: 'Request created' },
  'Заявка изменена': { uz: 'Ariza o‘zgartirildi', en: 'Request updated' },
  'Оплачено': { uz: 'To‘landi', en: 'Paid' },
  'Доставлено': { uz: 'Yetkazildi', en: 'Delivered' },
  'Принято': { uz: 'Qabul qilindi', en: 'Received' },
  'Выдано': { uz: 'Berildi', en: 'Issued' },
  'Закрыто': { uz: 'Yopildi', en: 'Closed' },
};

function translateDynamic(trimmed: string, lang: Exclude<Lang, 'ru'>): string | null {
  const pair = (uz: string, en: string) => (lang === 'uz' ? uz : en);
  let m = /^Вложения · (.+)$/.exec(trimmed);
  if (m) return pair(`Biriktirmalar · ${m[1]}`, `Attachments · ${m[1]}`);
  m = /^Позиция (\d+)$/.exec(trimmed);
  if (m) return pair(`Pozitsiya ${m[1]}`, `Item ${m[1]}`);
  m = /^срок: (.+)$/.exec(trimmed);
  if (m) return pair(`muddat: ${m[1]}`, `term: ${m[1]}`);
  m = /^Принято (.+) из (.+)$/.exec(trimmed);
  if (m) return pair(`Qabul qilindi ${m[1]} / ${m[2]}`, `Received ${m[1]} of ${m[2]}`);
  m = /^из (.+)$/.exec(trimmed);
  if (m) return pair(`${m[1]} dan`, `of ${m[1]}`);
  m = /^Сегодня · (.+)$/.exec(trimmed);
  if (m) return pair(`Bugun · ${m[1]}`, `Today · ${m[1]}`);
  m = /^Вчера · (.+)$/.exec(trimmed);
  if (m) return pair(`Kecha · ${m[1]}`, `Yesterday · ${m[1]}`);
  m = /^(\d+) чел\.$/.exec(trimmed);
  if (m) return pair(`${m[1]} kishi`, `${m[1]} people`);
  m = /^(\d+) отд\.$/.exec(trimmed);
  if (m) return pair(`${m[1]} bo‘lim`, `${m[1]} departments`);
  m = /^(.+) прав$/.exec(trimmed);
  if (m) return pair(`${m[1]} huquq`, `${m[1]} permissions`);
  return null;
}

export type I18nKey = keyof typeof dict.ru;

interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: I18nKey) => string;
  tl: (text: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);
const originals = new WeakMap<Node | Element, string>();
const hasCyrillic = (value: string): boolean => /[А-Яа-яЁё]/.test(value);

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
  const tl = useCallback((text: string): string => {
    if (lang === 'ru') return text;
    const trimmed = text.trim();
    const translated = literalDict[trimmed]?.[lang] ?? translateDynamic(trimmed, lang);
    if (!translated) return text;
    return text.replace(trimmed, translated);
  }, [lang]);

  useEffect(() => {
    const translateNode = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        const current = node.textContent ?? '';
        const stored = originals.get(node);
        if (!stored && !hasCyrillic(current)) return;
        const raw = stored ?? current;
        if (!stored) originals.set(node, raw);
        const next = tl(raw);
        if (node.textContent !== next) node.textContent = next;
        return;
      }
      if (!(node instanceof Element)) return;
      if (['SCRIPT', 'STYLE', 'TEXTAREA'].includes(node.tagName)) return;
      for (const attr of ['placeholder', 'aria-label', 'title']) {
        if (!node.hasAttribute(attr)) continue;
        const originalAttr = `data-i18n-original-${attr}`;
        const current = node.getAttribute(attr) ?? '';
        const stored = node.getAttribute(originalAttr);
        if (!stored && !hasCyrillic(current)) continue;
        const raw = stored ?? current;
        if (!stored) node.setAttribute(originalAttr, raw);
        const next = tl(raw);
        if (node.getAttribute(attr) !== next) node.setAttribute(attr, next);
      }
      for (const child of Array.from(node.childNodes)) translateNode(child);
    };
    const root = document.getElementById('root');
    if (!root) return;
    translateNode(root);
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of Array.from(m.addedNodes)) translateNode(n);
        if (m.type === 'characterData') translateNode(m.target);
        if (m.type === 'attributes') translateNode(m.target);
      }
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'aria-label', 'title'] });
    return () => observer.disconnect();
  }, [tl]);

  const value = useMemo<I18nValue>(() => ({
    lang,
    setLang,
    t: (key) => dict[lang][key] ?? dict.ru[key] ?? key,
    tl,
  }), [lang, setLang, tl]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}
