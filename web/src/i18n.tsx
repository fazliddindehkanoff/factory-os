import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

// FIXES 2026-07-17 (лист H): язык «Eng» заменён на «Türkçe» в переключателе.
// Код 'en' остаётся в типе для обратной совместимости (сохранённый выбор), но в
// выпадашке больше не предлагается.
export type Lang = 'ru' | 'uz' | 'en' | 'tr';

const STORAGE_KEY = 'factoryos.lang';
export const LANGUAGE_RELOAD_EVENT = 'factoryos:language-before-reload';

export const LANG_LABELS: Record<Lang, string> = {
  ru: 'RU',
  uz: 'UZ',
  en: 'Eng',
  tr: 'TR',
};

/** Языки, доступные в переключателе (лист H): Uzb / Рус / Türkçe. */
export const SWITCHER_LANGS: Lang[] = ['uz', 'ru', 'tr'];

/**
 * Picks an entity's name in the current UI language (otdels, unit types, etc. —
 * anything with a RU `name` plus optional `nameUz`/`nameTr`). Falls back to the
 * RU name whenever the localized field is blank, so translations can be filled
 * in gradually without ever showing an empty label.
 */
export function localizedName(entity: { name: string; nameUz?: string | null; nameTr?: string | null }, lang: Lang): string {
  if (lang === 'uz' && entity.nameUz) return entity.nameUz;
  if (lang === 'tr' && entity.nameTr) return entity.nameTr;
  return entity.name;
}

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
    'role.assistant': 'Ассистент',
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
    'proc.supplierName': 'Имя поставщика',
    'proc.supplierPhone': 'Телефон поставщика',
    'proc.supplierNamePlaceholder': 'Название компании или имя',
    'proc.supplierPhoneHint': 'Если номер уже есть, используем существующего поставщика. Иначе создадим нового автоматически.',
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
    'role.assistant': 'Assistent',
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
    'proc.supplierName': 'Yetkazib beruvchi nomi',
    'proc.supplierPhone': 'Yetkazib beruvchi telefoni',
    'proc.supplierNamePlaceholder': 'Kompaniya nomi yoki ism',
    'proc.supplierPhoneHint': 'Raqam mavjud bo‘lsa, shu yetkazib beruvchi ishlatiladi. Aks holda yangisi avtomatik yaratiladi.',
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
    'role.assistant': 'Assistant',
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
    'proc.supplierName': 'Supplier name',
    'proc.supplierPhone': 'Supplier phone',
    'proc.supplierNamePlaceholder': 'Company or contact name',
    'proc.supplierPhoneHint': 'An existing supplier with this number is reused; otherwise a new supplier is created automatically.',
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
  tr: {
    'nav.home': 'Ana sayfa',
    'nav.requests': 'Talepler',
    'nav.approvals': 'Onaylar',
    'nav.admin': 'Admin',
    'nav.warehouse': 'Depo',
    'nav.procurement': 'Satın alma',
    'nav.menu': 'Menü',
    'screen.detail': 'Talep',
    'menu.theme': 'Tema',
    'menu.themeDark': 'Koyu',
    'menu.themeLight': 'Açık',
    'menu.profile': 'Profil',
    'menu.language': 'Dil',
    'menu.logout': 'Çıkış',
    'role.assistant': 'Asistan',
    'common.cancel': 'İptal',
    'common.confirm': 'Onayla',
    'common.save': 'Kaydet',
    'common.close': 'Kapat',
    'common.loading': '…',
    'proc.assignee': 'Satın alma uzmanı',
    'proc.selectAssignee': 'Satın alma uzmanını seçin…',
    'proc.noAssignees': 'Satın alma yetkisine sahip kullanıcı yok',
    'proc.itemPrices': 'Kalem bazında fiyatlar',
    'proc.unitPrice': 'Birim fiyat',
    'proc.selectSupplier': '— tedarikçi seçin —',
    'proc.supplierManual': 'veya tedarikçiyi elle girin',
    'proc.supplier': 'Tedarikçi',
    'proc.supplierName': 'Tedarikçi adı',
    'proc.supplierPhone': 'Tedarikçi telefonu',
    'proc.supplierNamePlaceholder': 'Şirket veya kişi adı',
    'proc.supplierPhoneHint': 'Bu numara varsa mevcut tedarikçi kullanılır; yoksa otomatik olarak yeni tedarikçi oluşturulur.',
    'proc.nds': 'KDV %12',
    'proc.paymentType': 'Ödeme türü',
    'proc.selectPaymentType': 'Ödeme türünü seçin…',
    'proc.total': 'Toplam',
    'proc.leadTime': 'Teslim süresi (isteğe bağlı)',
    'proc.leadTimePlaceholder': 'örn. 10 gün',
    'proc.chooseQuotation': 'Tedarikçi teklifini seçin',
    'proc.addQuotationFirst': 'Önce en az bir teklif ekleyin.',
    'proc.deliveryTerm': 'süre',
    'reject.reason': 'Ret nedeni',
    'reject.selectReason': 'Neden seçin…',
    'reject.other': 'Diğer…',
    'reject.commentPlaceholder': 'Nedeni belirtin',
    'common.comment': 'Yorum',
    'common.commentPlaceholder': 'Neden / yorum',
    'action.approve': 'Onayla',
    'action.reject': 'Reddet',
    'action.returnRevision': 'Düzeltmeye geri gönder',
    'action.addQuotation': 'Teklif ekle',
    'action.approvePrice': 'Teklifi gönder',
    'action.whNext': 'Devam',
    'action.receiveFull': 'Teslim almayı onayla',
    'action.placeOrder': 'Sipariş ver',
  },
} as const;

const literalDict: Record<string, { uz: string; en: string; tr?: string }> = {
  'Загрузка…': { uz: 'Yuklanmoqda…', en: 'Loading…', tr: 'Yükleniyor…' },
  'Главная': { uz: 'Asosiy', en: 'Home', tr: 'Ana sayfa' },
  'Заявки': { uz: 'Arizalar', en: 'Requests', tr: 'Talepler' },
  'Согласования': { uz: 'Tasdiqlar', en: 'Approvals', tr: 'Onaylar' },
  'Склад': { uz: 'Ombor', en: 'Warehouse', tr: 'Depo' },
  'Закупки': { uz: 'Xaridlar', en: 'Purchasing', tr: 'Satın alma' },
  'Меню': { uz: 'Menyu', en: 'Menu', tr: 'Menü' },
  'Админ': { uz: 'Admin', en: 'Admin', tr: 'Admin' },
  'Администрирование': { uz: 'Admin boshqaruvi', en: 'Administration', tr: 'Yönetim' },
  'Новая заявка': { uz: 'Yangi ariza', en: 'New request', tr: 'Yeni talep' },
  'Все заявки': { uz: 'Barcha arizalar', en: 'All requests', tr: 'Tüm talepler' },
  'Мои заявки': { uz: 'Mening arizalarim', en: 'My requests', tr: 'Taleplerim' },
  'Ожидают меня': { uz: 'Meni kutmoqda', en: 'Waiting for me', tr: 'Beni bekleyenler' },
  'Активных всего': { uz: 'Jami aktiv', en: 'Total active', tr: 'Toplam aktif' },
  'Созданные мной': { uz: 'Men yaratganlar', en: 'Created by me', tr: 'Oluşturduklarım' },
  'Последние события': { uz: 'Oxirgi voqealar', en: 'Recent events', tr: 'Son olaylar' },
  'Ждут моего решения': { uz: 'Qarorimni kutmoqda', en: 'Awaiting my decision', tr: 'Kararımı bekleyenler' },
  'Нет заявок, ожидающих вашего решения.': { uz: 'Qaroringizni kutayotgan arizalar yo‘q.', en: 'No requests are awaiting your decision.', tr: 'Kararınızı bekleyen talep yok.' },
  'Очередь снабжения': { uz: 'Ta’minot navbati', en: 'Procurement queue', tr: 'Satın alma kuyruğu' },
  'Нет заявок в закупке.': { uz: 'Xarid jarayonida arizalar yo‘q.', en: 'No requests are in procurement.', tr: 'Satın alma sürecinde talep yok.' },
  'Тема': { uz: 'Mavzu', en: 'Theme', tr: 'Tema' },
  'Тема оформления': { uz: 'Ko‘rinish mavzusi', en: 'Appearance theme', tr: 'Görünüm teması' },
  'Тёмная': { uz: 'Qorong‘i', en: 'Dark', tr: 'Koyu' },
  'Светлая': { uz: 'Yorug‘', en: 'Light', tr: 'Açık' },
  'Профиль': { uz: 'Profil', en: 'Profile', tr: 'Profil' },
  'Редактировать профиль': { uz: 'Profilni tahrirlash', en: 'Edit profile', tr: 'Profili düzenle' },
  'Язык': { uz: 'Til', en: 'Language', tr: 'Dil' },
  'Выйти': { uz: 'Chiqish', en: 'Log out', tr: 'Çıkış' },
  'Закрыть': { uz: 'Yopish', en: 'Close', tr: 'Kapat' },
  'Отмена': { uz: 'Bekor qilish', en: 'Cancel', tr: 'İptal' },
  'Назад': { uz: 'Orqaga', en: 'Back', tr: 'Geri' },
  'Далее': { uz: 'Davom etish', en: 'Next', tr: 'Devam' },
  'Сохранить': { uz: 'Saqlash', en: 'Save', tr: 'Kaydet' },
  'Сохранено': { uz: 'Saqlandi', en: 'Saved', tr: 'Kaydedildi' },
  'Создать заявку': { uz: 'Ariza yaratish', en: 'Create request', tr: 'Talep oluştur' },
  'Изменить': { uz: 'Tahrirlash', en: 'Edit', tr: 'Düzenle' },
  'Удалить': { uz: 'O‘chirish', en: 'Delete', tr: 'Sil' },
  'Удалить заявку': { uz: 'Arizani o‘chirish', en: 'Delete request', tr: 'Talebi sil' },
  'Изменить заявку': { uz: 'Arizani tahrirlash', en: 'Edit request', tr: 'Talebi düzenle' },
  'Тип заявки': { uz: 'Ariza turi', en: 'Request type', tr: 'Talep türü' },
  'Отдел': { uz: 'Bo‘lim', en: 'Department', tr: 'Bölüm' },
  'Отделы': { uz: 'Bo‘limlar', en: 'Departments', tr: 'Bölümler' },
  'Склады': { uz: 'Omborlar', en: 'Warehouses', tr: 'Depolar' },
  'Заводы': { uz: 'Zavodlar', en: 'Factories', tr: 'Fabrikalar' },
  'Пользователи': { uz: 'Foydalanuvchilar', en: 'Users', tr: 'Kullanıcılar' },
  'Роли': { uz: 'Rollar', en: 'Roles', tr: 'Roller' },
  'Права': { uz: 'Huquqlar', en: 'Permissions', tr: 'Yetkiler' },
  'Структура': { uz: 'Tuzilma', en: 'Structure', tr: 'Yapı' },
  'Люди': { uz: 'Odamlar', en: 'People', tr: 'Kişiler' },
  'Форма': { uz: 'Forma', en: 'Form', tr: 'Form' },
  'Материалы': { uz: 'Materiallar', en: 'Materials', tr: 'Malzemeler' },
  'Аудит': { uz: 'Audit', en: 'Audit', tr: 'Denetim' },
  'Настройки': { uz: 'Sozlamalar', en: 'Settings', tr: 'Ayarlar' },
  'Обзор': { uz: 'Umumiy ko‘rinish', en: 'Overview', tr: 'Genel bakış' },
  'Активные заявки': { uz: 'Aktiv arizalar', en: 'Active requests', tr: 'Aktif talepler' },
  'Позиции': { uz: 'Pozitsiyalar', en: 'Items', tr: 'Kalemler' },
  'Количество:': { uz: 'Miqdor:', en: 'Quantity:', tr: 'Miktar:' },
  'Поставщик:': { uz: 'Yetkazib beruvchi:', en: 'Supplier:', tr: 'Tedarikçi:' },
  'Условия:': { uz: 'Shartlar:', en: 'Terms:', tr: 'Koşullar:' },
  'Цена за 1:': { uz: '1 dona narxi:', en: 'Unit price:', tr: 'Birim fiyat:' },
  'Сумма:': { uz: 'Summa:', en: 'Amount:', tr: 'Tutar:' },
  'Процесс согласования': { uz: 'Tasdiqlash jarayoni', en: 'Approval process', tr: 'Onay süreci' },
  'Примечание': { uz: 'Izoh', en: 'Note', tr: 'Not' },
  'Примечания': { uz: 'Izohlar', en: 'Notes', tr: 'Notlar' },
  'Спецификация заявки': { uz: 'Ariza spetsifikatsiyasi', en: 'Request specification', tr: 'Talep şartnamesi' },
  'Наименование материала или услуги': { uz: 'Material yoki xizmat nomi', en: 'Material or service name', tr: 'Malzeme veya hizmet adı' },
  'КОД товара': { uz: 'Tovar KODI', en: 'Item code', tr: 'Ürün KODU' },
  'Вложение файла или изображения': { uz: 'Fayl yoki rasm biriktirish', en: 'Attach file or image', tr: 'Dosya veya görsel ekle' },
  'Дополнительно': { uz: 'Qo‘shimcha', en: 'Additional', tr: 'Ek bilgiler' },
  'Коммерческие предложения': { uz: 'Tijorat takliflari', en: 'Commercial offers', tr: 'Ticari teklifler' },
  'выбран': { uz: 'tanlangan', en: 'selected', tr: 'seçildi' },
  'Вложения': { uz: 'Biriktirmalar', en: 'Attachments', tr: 'Ekler' },
  '+ Файл': { uz: '+ Fayl', en: '+ File', tr: '+ Dosya' },
  'Скачать': { uz: 'Yuklab olish', en: 'Download', tr: 'İndir' },
  'Статус': { uz: 'Holat', en: 'Status', tr: 'Durum' },
  'Автор': { uz: 'Muallif', en: 'Author', tr: 'Oluşturan' },
  'Завод': { uz: 'Zavod', en: 'Factory', tr: 'Fabrika' },
  'Объект': { uz: 'Obyekt', en: 'Object', tr: 'Tesis' },
  'Место закупа': { uz: 'Xarid joyi', en: 'Purchase origin', tr: 'Satın alma yeri' },
  'Ответственный': { uz: 'Mas’ul', en: 'Responsible', tr: 'Sorumlu' },
  'Статус снабжения': { uz: 'Ta’minot holati', en: 'Procurement status', tr: 'Satın alma durumu' },
  'Нужно к': { uz: 'Kerak bo‘lgan sana', en: 'Needed by', tr: 'İhtiyaç tarihi' },
  'Местный': { uz: 'Mahalliy', en: 'Local', tr: 'Yerli' },
  'Импорт': { uz: 'Import', en: 'Import', tr: 'İthal' },
  'Я начал': { uz: 'Boshladim', en: 'Started', tr: 'Başladım' },
  'В процессе оплаты': { uz: 'To‘lov jarayonida', en: 'Payment in progress', tr: 'Ödeme sürecinde' },
  'В процессе доставки': { uz: 'Yetkazish jarayonida', en: 'Delivery in progress', tr: 'Teslimat sürecinde' },
  'Заказ оформлен': { uz: 'Buyurtma rasmiylashtirildi', en: 'Order placed', tr: 'Sipariş verildi' },
  'Проблема': { uz: 'Muammo', en: 'Problem', tr: 'Sorun' },
  'Создана': { uz: 'Yaratildi', en: 'Created', tr: 'Oluşturuldu' },
  'Возвращено на доработку': { uz: 'Qayta ishlashga qaytarildi', en: 'Returned for revision', tr: 'Düzeltmeye geri gönderildi' },
  'Комментарий:': { uz: 'Izoh:', en: 'Comment:', tr: 'Yorum:' },
  'Отклонено': { uz: 'Rad etildi', en: 'Rejected', tr: 'Reddedildi' },
  'Отменено': { uz: 'Bekor qilindi', en: 'Cancelled', tr: 'İptal edildi' },
  'Согласовано': { uz: 'Tasdiqlandi', en: 'Approved', tr: 'Onaylandı' },
  'Текущий этап · ожидает': { uz: 'Joriy bosqich · kutmoqda', en: 'Current step · waiting', tr: 'Mevcut aşama · bekliyor' },
  'Ожидает': { uz: 'Kutmoqda', en: 'Waiting', tr: 'Bekliyor' },
  'В наличии': { uz: 'Mavjud', en: 'In stock', tr: 'Stokta var' },
  'Нет': { uz: 'Yo‘q', en: 'No', tr: 'Yok' },
  'Нет — в закупку': { uz: 'Yo‘q — xaridga', en: 'No — to purchasing', tr: 'Yok — satın almaya' },
  'Принято:': { uz: 'Qabul qilindi:', en: 'Received:', tr: 'Teslim alınan:' },
  'Материал': { uz: 'Material', en: 'Material', tr: 'Malzeme' },
  'Количество': { uz: 'Miqdor', en: 'Quantity', tr: 'Miktar' },
  'Причина': { uz: 'Sabab', en: 'Reason', tr: 'Neden' },
  'Остатки': { uz: 'Qoldiqlar', en: 'Balances', tr: 'Stoklar' },
  'Приёмка': { uz: 'Qabul', en: 'Receiving', tr: 'Mal kabul' },
  'Выдача': { uz: 'Berish', en: 'Issue', tr: 'Çıkış' },
  'Журнал': { uz: 'Jurnal', en: 'Journal', tr: 'Günlük' },
  'Приход': { uz: 'Kirim', en: 'Income', tr: 'Giriş' },
  'Расход': { uz: 'Chiqim', en: 'Outcome', tr: 'Çıkış' },
  'Коррекция': { uz: 'Tuzatish', en: 'Correction', tr: 'Düzeltme' },
  'Ничего не найдено': { uz: 'Hech narsa topilmadi', en: 'Nothing found', tr: 'Sonuç bulunamadı' },
  'Поиск по материалу или складу...': { uz: 'Material yoki ombor bo‘yicha qidirish...', en: 'Search by material or warehouse...', tr: 'Malzeme veya depoya göre ara...' },
  'Поиск по номеру или названию...': { uz: 'Raqam yoki nom bo‘yicha qidirish...', en: 'Search by number or title...', tr: 'Numara veya ada göre ara...' },
  'Здесь пока пусто': { uz: 'Hozircha bo‘sh', en: 'Nothing here yet', tr: 'Henüz boş' },
  'Нет остатков на складе': { uz: 'Omborda qoldiq yo‘q', en: 'No warehouse balances', tr: 'Depoda stok yok' },
  'Нет записей в журнале': { uz: 'Jurnalda yozuvlar yo‘q', en: 'No journal records', tr: 'Günlükte kayıt yok' },
  'Принять на склад': { uz: 'Omborga qabul qilish', en: 'Receive to warehouse', tr: 'Depoya al' },
  'Выдать со склада': { uz: 'Ombordan berish', en: 'Issue from warehouse', tr: 'Depodan çıkar' },
  'Отправка...': { uz: 'Yuborilmoqda...', en: 'Sending...', tr: 'Gönderiliyor...' },
  'Поставщики': { uz: 'Yetkazib beruvchilar', en: 'Suppliers', tr: 'Tedarikçiler' },
  'Финансы': { uz: 'Moliya', en: 'Finance', tr: 'Finans' },
  'Добавить': { uz: 'Qo‘shish', en: 'Add', tr: 'Ekle' },
  'Добавить человека': { uz: 'Odam qo‘shish', en: 'Add person', tr: 'Kişi ekle' },
  'Имя': { uz: 'Ism', en: 'Name', tr: 'Ad' },
  'Назначить': { uz: 'Tayinlash', en: 'Assign', tr: 'Ata' },
  'Назначить права': { uz: 'Huquq tayinlash', en: 'Assign permissions', tr: 'Yetki ata' },
  'Снять': { uz: 'Olib tashlash', en: 'Remove', tr: 'Kaldır' },
  'Сбросить PIN': { uz: 'PINni tiklash', en: 'Reset PIN', tr: 'PIN sıfırla' },
  'Удалить пользователя': { uz: 'Foydalanuvchini o‘chirish', en: 'Delete user', tr: 'Kullanıcıyı sil' },
  'Готово': { uz: 'Tayyor', en: 'Done', tr: 'Tamam' },
  'Название': { uz: 'Nomi', en: 'Name', tr: 'Ad' },
  'Без прав': { uz: 'Huquqsiz', en: 'No permissions', tr: 'Yetkisiz' },
  'Весь холдинг': { uz: 'Butun holding', en: 'Whole holding', tr: 'Tüm holding' },
  'Не задано': { uz: 'Belgilanmagan', en: 'Not set', tr: 'Belirlenmedi' },
  'Сохранить настройки': { uz: 'Sozlamalarni saqlash', en: 'Save settings', tr: 'Ayarları kaydet' },
  'Название организации': { uz: 'Tashkilot nomi', en: 'Organization name', tr: 'Kuruluş adı' },
  'Валюта': { uz: 'Valyuta', en: 'Currency', tr: 'Para birimi' },
  'Тема по умолчанию': { uz: 'Standart mavzu', en: 'Default theme', tr: 'Varsayılan tema' },
  'Типы оплаты для снабжения': { uz: 'Ta’minot uchun to‘lov turlari', en: 'Procurement payment types', tr: 'Satın alma ödeme türleri' },
  'Тип оплаты': { uz: 'To‘lov turi', en: 'Payment type', tr: 'Ödeme türü' },
  'Выберите тип оплаты…': { uz: 'To‘lov turini tanlang…', en: 'Choose payment type…', tr: 'Ödeme türünü seçin…' },
  'Снабженец': { uz: 'Ta’minotchi', en: 'Procurement user', tr: 'Satın alma uzmanı' },
  'Выберите снабженца…': { uz: 'Ta’minotchini tanlang…', en: 'Choose procurement user…', tr: 'Satın alma uzmanını seçin…' },
  'Цены по позициям': { uz: 'Pozitsiyalar bo‘yicha narxlar', en: 'Prices by item', tr: 'Kalem bazında fiyatlar' },
  'Цена за 1': { uz: '1 dona narxi', en: 'Unit price', tr: 'Birim fiyat' },
  'Поставщик': { uz: 'Yetkazib beruvchi', en: 'Supplier', tr: 'Tedarikçi' },
  'НДС 12%': { uz: 'NDS 12%', en: 'VAT 12%', tr: 'KDV %12' },
  'Итого': { uz: 'Jami', en: 'Total', tr: 'Toplam' },
  'Срок поставки (необязательно)': { uz: 'Yetkazish muddati (ixtiyoriy)', en: 'Delivery term (optional)', tr: 'Teslim süresi (isteğe bağlı)' },
  'Выберите КП поставщика': { uz: 'Yetkazib beruvchi taklifini tanlang', en: 'Choose supplier offer', tr: 'Tedarikçi teklifini seçin' },
  'Сначала добавьте хотя бы одно КП.': { uz: 'Avval kamida bitta taklif qo‘shing.', en: 'Add at least one offer first.', tr: 'Önce en az bir teklif ekleyin.' },
  'Причина отклонения': { uz: 'Rad etish sababi', en: 'Rejection reason', tr: 'Ret nedeni' },
  'Выберите причину…': { uz: 'Sababni tanlang…', en: 'Choose reason…', tr: 'Neden seçin…' },
  'Другое…': { uz: 'Boshqa…', en: 'Other…', tr: 'Diğer…' },
  'Комментарий': { uz: 'Izoh', en: 'Comment', tr: 'Yorum' },
  'Подтвердить': { uz: 'Tasdiqlash', en: 'Confirm', tr: 'Onayla' },
  'Одобрить': { uz: 'Tasdiqlash', en: 'Approve', tr: 'Onayla' },
  'Отклонить': { uz: 'Rad etish', en: 'Reject', tr: 'Reddet' },
  'Вернуть на доработку': { uz: 'Qayta ishlashga qaytarish', en: 'Return for revision', tr: 'Düzeltmeye geri gönder' },
  'Пересмотреть цену': { uz: 'Narxni qayta ko‘rib chiqish', en: 'Review price', tr: 'Fiyatı yeniden değerlendir' },
  'Пересмотреть заявку': { uz: 'Arizani qayta ko‘rib chiqish', en: 'Review request', tr: 'Talebi yeniden değerlendir' },
  'Завышенная цена': { uz: 'Narx oshirilgan', en: 'Price too high', tr: 'Fiyat çok yüksek' },
  'Найти других поставщиков': { uz: 'Boshqa yetkazib beruvchilarni topish', en: 'Find other suppliers', tr: 'Başka tedarikçiler bul' },
  'Найти на перечисление': { uz: 'Perechisleniye orqali topish', en: 'Find via bank transfer', tr: 'Havale ile bul' },
  'Сделать конкурентный лист': { uz: 'Konkurent varaq tuzish', en: 'Make a competitive sheet', tr: 'Rekabet listesi hazırla' },
  'Добавить предложение': { uz: 'Taklif qo‘shish', en: 'Add offer', tr: 'Teklif ekle' },
  'Отправить предложение': { uz: 'Taklifni yuborish', en: 'Send offer', tr: 'Teklifi gönder' },
  'Оформить заказ': { uz: 'Buyurtmani rasmiylashtirish', en: 'Place order', tr: 'Sipariş ver' },
  'Уведомления': { uz: 'Bildirishnomalar', en: 'Notifications', tr: 'Bildirimler' },
  '← Назад': { uz: '← Orqaga', en: '← Back', tr: '← Geri' },
  '+ Завод': { uz: '+ Zavod', en: '+ Factory', tr: '+ Fabrika' },
  '+ Отдел': { uz: '+ Bo‘lim', en: '+ Department', tr: '+ Bölüm' },
  '+ Склад': { uz: '+ Ombor', en: '+ Warehouse', tr: '+ Depo' },
  '+ Права': { uz: '+ Huquq', en: '+ Permission', tr: '+ Yetki' },
  'Без завода (холдинг)': { uz: 'Zavodsiz (holding)', en: 'No factory (holding)', tr: 'Fabrikasız (holding)' },
  'Нет отделов': { uz: 'Bo‘limlar yo‘q', en: 'No departments', tr: 'Bölüm yok' },
  'Нет складов': { uz: 'Omborlar yo‘q', en: 'No warehouses', tr: 'Depo yok' },
  'Нет заводов в этом холдинге.': { uz: 'Bu holdingda zavodlar yo‘q.', en: 'No factories in this holding.', tr: 'Bu holdingde fabrika yok.' },
  'В отделе нет сотрудников.': { uz: 'Bo‘limda xodimlar yo‘q.', en: 'No employees in this department.', tr: 'Bu bölümde çalışan yok.' },
  'Никого не найдено.': { uz: 'Hech kim topilmadi.', en: 'No people found.', tr: 'Kimse bulunamadı.' },
  'Прав нет.': { uz: 'Huquqlar yo‘q.', en: 'No permissions.', tr: 'Yetki yok.' },
  'Создание заявки': { uz: 'Ariza yaratish', en: 'Request creation', tr: 'Talep oluşturma' },
  'Руководитель отдела': { uz: 'Bo‘lim boshlig‘i', en: 'Department head', tr: 'Bölüm müdürü' },
  'Руководитель снабжения': { uz: 'Ta’minot rahbari', en: 'Procurement head', tr: 'Satın alma yöneticisi' },
  'Дирекция': { uz: 'Direksiya', en: 'Management', tr: 'Yönetim' },
  'Главный инженер': { uz: 'Bosh muhandis', en: 'Chief engineer', tr: 'Baş mühendis' },
  'Руководитель снабжения — принятие заявки': { uz: 'Ta’minot rahbari — arizani qabul qilish', en: 'Procurement head — request intake', tr: 'Satın alma yöneticisi — talep kabulü' },
  'Снабженец — процесс поиска': { uz: 'Ta’minotchi — qidiruv jarayoni', en: 'Procurement specialist — search process', tr: 'Satın alma uzmanı — arama süreci' },
  'Руководитель снабжения — проверка цены': { uz: 'Ta’minot rahbari — narxni tekshirish', en: 'Procurement head — price review', tr: 'Satın alma yöneticisi — fiyat kontrolü' },
  'Директор': { uz: 'Direktor', en: 'Director', tr: 'Direktör' },
  'Снабженец — оформление заказа': { uz: 'Ta’minotchi — buyurtmani rasmiylashtirish', en: 'Procurement specialist — order placement', tr: 'Satın alma uzmanı — sipariş oluşturma' },
  'Склад — приёмка': { uz: 'Ombor — qabul qilish', en: 'Warehouse — receiving', tr: 'Depo — mal kabul' },
  'Заявка изменена': { uz: 'Ariza o‘zgartirildi', en: 'Request updated', tr: 'Talep güncellendi' },
  'Оплачено': { uz: 'To‘landi', en: 'Paid', tr: 'Ödendi' },
  'Доставлено': { uz: 'Yetkazildi', en: 'Delivered', tr: 'Teslim edildi' },
  'Принято': { uz: 'Qabul qilindi', en: 'Received', tr: 'Teslim alındı' },
  'Выдано': { uz: 'Berildi', en: 'Issued', tr: 'Çıkışı yapıldı' },
  'Закрыто': { uz: 'Yopildi', en: 'Closed', tr: 'Kapatıldı' },
  // FIXES 2026-07-17: добор строк, «протекавших» на русском при выбранном узб/тур.
  // ── Шапка / приветствие + aria-label кнопок ──
  'Добрый день,': { uz: 'Xayrli kun,', en: 'Good afternoon,', tr: 'İyi günler,' },
  'Сменить тему': { uz: 'Mavzuni almashtirish', en: 'Toggle theme', tr: 'Temayı değiştir' },
  'Календарь': { uz: 'Kalendar', en: 'Calendar', tr: 'Takvim' },
  // ── Секции главного экрана ──
  'Быстрые действия': { uz: 'Tezkor amallar', en: 'Quick actions', tr: 'Hızlı işlemler' },
  'Заявки по статусам': { uz: 'Holat bo‘yicha arizalar', en: 'Requests by status', tr: 'Duruma göre talepler' },
  // ── Метки карточек списка ──
  'Отдел снабжения': { uz: 'Ta’minot bo‘limi', en: 'Procurement dept.', tr: 'Satın alma bölümü' },
  'Создано мной': { uz: 'Men yaratganman', en: 'Created by me', tr: 'Benim oluşturduğum' },
  // ── Статусы (statusMeta) ──
  'Проверка склада': { uz: 'Ombor tekshiruvi', en: 'Warehouse check', tr: 'Depo kontrolü' },
  'Частично в наличии': { uz: 'Qisman mavjud', en: 'Partially in stock', tr: 'Kısmen stokta' },
  'Нет в наличии': { uz: 'Mavjud emas', en: 'Out of stock', tr: 'Stokta yok' },
  'В закупке': { uz: 'Xaridda', en: 'In procurement', tr: 'Satın almada' },
  'Назначение снабженца': { uz: 'Ta’minotchi tayinlash', en: 'Assigning buyer', tr: 'Alıcı atama' },
  'Оформление заказа': { uz: 'Buyurtma rasmiylashtirish', en: 'Placing order', tr: 'Sipariş oluşturma' },
  'Получены КП': { uz: 'Takliflar olindi', en: 'Offers received', tr: 'Teklifler alındı' },
  'На согласовании': { uz: 'Kelishuvda', en: 'In approval', tr: 'Onayda' },
  'Согласована': { uz: 'Kelishilgan', en: 'Approved', tr: 'Onaylandı' },
  'Отклонена': { uz: 'Rad etilgan', en: 'Rejected', tr: 'Reddedildi' },
  'Оплачена': { uz: 'To‘langan', en: 'Paid', tr: 'Ödendi' },
  'В доставке': { uz: 'Yetkazishda', en: 'In delivery', tr: 'Teslimatta' },
  'Приёмка на складе': { uz: 'Omborda qabul', en: 'Receiving at warehouse', tr: 'Depoda kabul' },
  'Ожидает оплаты': { uz: 'To‘lovni kutmoqda', en: 'Awaiting payment', tr: 'Ödeme bekliyor' },
  'Доставка': { uz: 'Yetkazish', en: 'Delivery', tr: 'Teslimat' },
  'Принята на склад': { uz: 'Omborga qabul qilingan', en: 'Received to warehouse', tr: 'Depoya alındı' },
  'Выдана в отдел': { uz: 'Bo‘limga berilgan', en: 'Issued to department', tr: 'Bölüme verildi' },
  'Подтверждение получения': { uz: 'Qabulni tasdiqlash', en: 'Confirm receipt', tr: 'Teslimatı onayla' },
  'Закрыта': { uz: 'Yopilgan', en: 'Closed', tr: 'Kapatıldı' },
  'Отменена': { uz: 'Bekor qilingan', en: 'Cancelled', tr: 'İptal edildi' },
  'В архиве': { uz: 'Arxivda', en: 'Archived', tr: 'Arşivde' },
  'Черновик': { uz: 'Qoralama', en: 'Draft', tr: 'Taslak' },
  // ── KPI-плитки ──
  'Возвращённые': { uz: 'Qaytarilganlar', en: 'Returned', tr: 'İade edilenler' },
  'Низкий остаток': { uz: 'Kam qoldiq', en: 'Low stock', tr: 'Düşük stok' },
  'Для закупа': { uz: 'Xarid uchun', en: 'To purchase', tr: 'Satın alınacak' },
  // ── Список заявок: фильтры/кнопки ──
  'Только мои': { uz: 'Faqat meniki', en: 'Mine only', tr: 'Yalnızca benim' },
  'Все': { uz: 'Barchasi', en: 'All', tr: 'Hepsi' },
  'Создать': { uz: 'Yaratish', en: 'Create', tr: 'Oluştur' },
  '+ Создать': { uz: '+ Yaratish', en: '+ Create', tr: '+ Oluştur' },
  'Сбросить дату': { uz: 'Sanani tiklash', en: 'Reset date', tr: 'Tarihi sıfırla' },
  'Закупка': { uz: 'Xarid', en: 'Procurement', tr: 'Satın alma' },
  'Попробуйте другой запрос или сбросьте фильтр.': { uz: 'Boshqa so‘rov kiriting yoki filtrni tiklang.', en: 'Try another query or reset the filter.', tr: 'Başka bir sorgu deneyin veya filtreyi sıfırlayın.' },
  'Заявок нет. Создайте первую с главного экрана.': { uz: 'Arizalar yo‘q. Birinchisini asosiy ekrandan yarating.', en: 'No requests. Create the first one from the home screen.', tr: 'Talep yok. İlkini ana ekrandan oluşturun.' },
  '+ Новая заявка': { uz: '+ Yangi ariza', en: '+ New request', tr: '+ Yeni talep' },
  // ── Новые экраны и состояния (добавлены после первоначального покрытия i18n) ──
  'Входящих нет': { uz: 'Kiruvchi arizalar yo‘q', en: 'No incoming requests', tr: 'Gelen talep yok' },
  'Сейчас нет заявок, требующих вашего действия.': { uz: 'Hozir sizning harakatingizni talab qiladigan arizalar yo‘q.', en: 'There are no requests requiring your action right now.', tr: 'Şu anda eyleminizi gerektiren talep yok.' },
  'Заявок в закупке нет.': { uz: 'Xarid jarayonida arizalar yo‘q.', en: 'No requests in procurement.', tr: 'Satın alma sürecinde talep yok.' },
  'Очередь': { uz: 'Navbat', en: 'Queue', tr: 'Kuyruk' },
  'Пока нет событий — здесь появятся обновления по вашим заявкам.': { uz: 'Hozircha voqealar yo‘q — arizalaringiz bo‘yicha yangilanishlar shu yerda ko‘rinadi.', en: 'No events yet — updates about your requests will appear here.', tr: 'Henüz olay yok — taleplerinizle ilgili güncellemeler burada görünecek.' },
  'Менеджер по снабжению': { uz: 'Ta’minot menejeri', en: 'Procurement manager', tr: 'Satın alma yöneticisi' },
  'PIN для подписи': { uz: 'Imzo uchun PIN', en: 'Signing PIN', tr: 'İmza PIN’i' },
  '4–8 цифр. Нужен для согласования и других действий с подписью.': { uz: '4–8 raqam. Tasdiqlash va boshqa imzoli amallar uchun kerak.', en: '4–8 digits. Required for approvals and other signed actions.', tr: '4–8 rakam. Onaylar ve diğer imzalı işlemler için gereklidir.' },
  'У вас нет прав на согласование': { uz: 'Tasdiqlash huquqingiz yo‘q', en: 'You do not have approval permissions', tr: 'Onay yetkiniz yok' },
  'Обратитесь к администратору для получения необходимых прав.': { uz: 'Kerakli huquqlarni olish uchun administratorga murojaat qiling.', en: 'Contact an administrator to get the required permissions.', tr: 'Gerekli yetkileri almak için yöneticinize başvurun.' },
  'Вы не привязаны к организации. Попросите администратора назначить вам права.': { uz: 'Siz tashkilotga biriktirilmagansiz. Administratordan huquq tayinlashini so‘rang.', en: 'You are not linked to an organization. Ask an administrator to assign your permissions.', tr: 'Bir kuruluşa bağlı değilsiniz. Yöneticiden yetkilerinizi atamasını isteyin.' },
  'Заявитель': { uz: 'Ariza beruvchi', en: 'Requester', tr: 'Talep sahibi' },
  'Отметьте наличие по каждой позиции перед нажатием «Далее».': { uz: '«Davom etish»ni bosishdan oldin har bir pozitsiya mavjudligini belgilang.', en: 'Mark availability for each item before clicking “Continue”.', tr: '“Devam”a basmadan önce her kalemin stok durumunu belirtin.' },
  'Проверка склада (есть / частично / нет)': { uz: 'Ombor tekshiruvi (bor / qisman / yo‘q)', en: 'Warehouse check (in stock / partial / none)', tr: 'Depo kontrolü (var / kısmi / yok)' },
  'Принятие заявки снабжением': { uz: 'Arizani ta’minot tomonidan qabul qilish', en: 'Procurement request intake', tr: 'Talebin satın alma tarafından alınması' },
  'Поиск поставщика (КП)': { uz: 'Yetkazib beruvchini qidirish (taklif)', en: 'Supplier search (offers)', tr: 'Tedarikçi arama (teklifler)' },
  'Проверка цены и поставщика': { uz: 'Narx va yetkazib beruvchini tekshirish', en: 'Price and supplier review', tr: 'Fiyat ve tedarikçi kontrolü' },
  'Оплата (PIN)': { uz: 'To‘lov (PIN)', en: 'Payment (PIN)', tr: 'Ödeme (PIN)' },
  'Оформление заказа (заказ / отправка / поставка)': { uz: 'Buyurtmani rasmiylashtirish (buyurtma / jo‘natish / yetkazish)', en: 'Order placement (order / dispatch / delivery)', tr: 'Sipariş oluşturma (sipariş / gönderim / teslimat)' },
  'Приёмка на склад (по позициям)': { uz: 'Omborga qabul qilish (pozitsiyalar bo‘yicha)', en: 'Warehouse receiving (by item)', tr: 'Depoya kabul (kalem bazında)' },
  'Подтверждение получения (закрытие)': { uz: 'Qabulni tasdiqlash (yopish)', en: 'Confirm receipt (close)', tr: 'Teslimatı onaylama (kapatma)' },
  'Согласование (подпись, PIN)': { uz: 'Tasdiqlash (imzo, PIN)', en: 'Approval (signature, PIN)', tr: 'Onay (imza, PIN)' },
  'Согласование: одобрено': { uz: 'Tasdiqlash: ma’qullandi', en: 'Approval: approved', tr: 'Onay: onaylandı' },
  'Согласование: отклонено': { uz: 'Tasdiqlash: rad etildi', en: 'Approval: rejected', tr: 'Onay: reddedildi' },
  'Права назначены': { uz: 'Huquqlar tayinlandi', en: 'Permissions assigned', tr: 'Yetkiler atandı' },
  'Права сняты': { uz: 'Huquqlar olib tashlandi', en: 'Permissions removed', tr: 'Yetkiler kaldırıldı' },
  'Показать ещё': { uz: 'Yana ko‘rsatish', en: 'Show more', tr: 'Daha fazla göster' },
  'Управление заявками': { uz: 'Arizalarni boshqarish', en: 'Request management', tr: 'Talep yönetimi' },
  'Активных заявок нет.': { uz: 'Faol arizalar yo‘q.', en: 'No active requests.', tr: 'Aktif talep yok.' },
  'Удалённые записи сохраняются в базе и журнале аудита.': { uz: 'O‘chirilgan yozuvlar ma’lumotlar bazasi va audit jurnalida saqlanadi.', en: 'Deleted records remain in the database and audit log.', tr: 'Silinen kayıtlar veritabanında ve denetim günlüğünde saklanır.' },
  'Номенклатура': { uz: 'Nomenklatura', en: 'Item catalogue', tr: 'Malzeme kataloğu' },
  'Склад отдела': { uz: 'Bo‘lim ombori', en: 'Department warehouse', tr: 'Bölüm deposu' },
  'НДС': { uz: 'NDS', en: 'VAT', tr: 'KDV' },
  'Сохранено ✓': { uz: 'Saqlandi ✓', en: 'Saved ✓', tr: 'Kaydedildi ✓' },
  'PIN сохранён ✓': { uz: 'PIN saqlandi ✓', en: 'PIN saved ✓', tr: 'PIN kaydedildi ✓' },
  'Причина (обязательно)': { uz: 'Sabab (majburiy)', en: 'Reason (required)', tr: 'Neden (zorunlu)' },
  'Не удалось выгрузить CSV': { uz: 'CSVni yuklab bo‘lmadi', en: 'Could not export CSV', tr: 'CSV dışa aktarılamadı' },
  'Не удалось скачать файл': { uz: 'Faylni yuklab bo‘lmadi', en: 'Could not download file', tr: 'Dosya indirilemedi' },
  'Нет связи с сервером. Проверьте подключение.': { uz: 'Server bilan aloqa yo‘q. Ulanishni tekshiring.', en: 'No connection to the server. Check your connection.', tr: 'Sunucu bağlantısı yok. Bağlantınızı kontrol edin.' },
  'Сессия истекла — войдите снова': { uz: 'Seans tugadi — qayta kiring', en: 'Session expired — sign in again', tr: 'Oturum sona erdi — tekrar giriş yapın' },
  'Сервер не ответил вовремя — возможно, база просыпается. Повторите через пару секунд.': { uz: 'Server o‘z vaqtida javob bermadi — baza uyg‘onayotgan bo‘lishi mumkin. Bir necha soniyadan so‘ng qayta urinib ko‘ring.', en: 'The server timed out — the database may be waking up. Try again in a few seconds.', tr: 'Sunucu zamanında yanıt vermedi — veritabanı uyanıyor olabilir. Birkaç saniye sonra tekrar deneyin.' },
  // ── Остальные строки форм/админки, которые раньше просачивались на RU ──
  'Вход...': { uz: 'Kirish…', en: 'Signing in…', tr: 'Giriş…' },
  'Войти (dev)': { uz: 'Kirish (dev)', en: 'Sign in (dev)', tr: 'Giriş (dev)' },
  'DEV: сменить пользователя': { uz: 'DEV: foydalanuvchini almashtirish', en: 'DEV: switch user', tr: 'DEV: kullanıcıyı değiştir' },
  'Аварийная': { uz: 'Avariya', en: 'Emergency', tr: 'Acil' },
  'Критичная': { uz: 'Juda muhim', en: 'Critical', tr: 'Kritik' },
  'Низкая': { uz: 'Past', en: 'Low', tr: 'Düşük' },
  'Стандартная': { uz: 'Standart', en: 'Standard', tr: 'Standart' },
  'Срочная': { uz: 'Shoshilinch', en: 'Urgent', tr: 'Acil' },
  'Январь': { uz: 'Yanvar', en: 'January', tr: 'Ocak' },
  'Февраль': { uz: 'Fevral', en: 'February', tr: 'Şubat' },
  'Март': { uz: 'Mart', en: 'March', tr: 'Mart' },
  'Апрель': { uz: 'Aprel', en: 'April', tr: 'Nisan' },
  'Май': { uz: 'May', en: 'May', tr: 'Mayıs' },
  'Июнь': { uz: 'Iyun', en: 'June', tr: 'Haziran' },
  'Июль': { uz: 'Iyul', en: 'July', tr: 'Temmuz' },
  'Август': { uz: 'Avgust', en: 'August', tr: 'Ağustos' },
  'Сентябрь': { uz: 'Sentabr', en: 'September', tr: 'Eylül' },
  'Октябрь': { uz: 'Oktabr', en: 'October', tr: 'Ekim' },
  'Ноябрь': { uz: 'Noyabr', en: 'November', tr: 'Kasım' },
  'Декабрь': { uz: 'Dekabr', en: 'December', tr: 'Aralık' },
  'Пн': { uz: 'Du', en: 'Mon', tr: 'Pzt' },
  'Вт': { uz: 'Se', en: 'Tue', tr: 'Sal' },
  'Ср': { uz: 'Cho', en: 'Wed', tr: 'Çar' },
  'Чт': { uz: 'Pa', en: 'Thu', tr: 'Per' },
  'Пт': { uz: 'Ju', en: 'Fri', tr: 'Cum' },
  'Сб': { uz: 'Sha', en: 'Sat', tr: 'Cmt' },
  'Вс': { uz: 'Yak', en: 'Sun', tr: 'Paz' },
  'Без даты': { uz: 'Sanasiz', en: 'No date', tr: 'Tarih yok' },
  'Без названия': { uz: 'Nomsiz', en: 'Untitled', tr: 'Adsız' },
  'Название продукта': { uz: 'Mahsulot nomi', en: 'Product name', tr: 'Ürün adı' },
  'Добавить продукт': { uz: 'Mahsulot qo‘shish', en: 'Add product', tr: 'Ürün ekle' },
  'Удалить продукт': { uz: 'Mahsulotni o‘chirish', en: 'Delete product', tr: 'Ürünü sil' },
  'Добавьте хотя бы один продукт': { uz: 'Kamida bitta mahsulot qo‘shing', en: 'Add at least one product', tr: 'En az bir ürün ekleyin' },
  'Добавьте хотя бы один вариант': { uz: 'Kamida bitta variant qo‘shing', en: 'Add at least one option', tr: 'En az bir seçenek ekleyin' },
  'Укажите количество больше нуля для каждого продукта': { uz: 'Har bir mahsulot uchun noldan katta miqdor kiriting', en: 'Enter a quantity greater than zero for each product', tr: 'Her ürün için sıfırdan büyük bir miktar girin' },
  'Название (RU)': { uz: 'Nomi (RU)', en: 'Name (RU)', tr: 'Ad (RU)' },
  'Наименование': { uz: 'Nomi', en: 'Name', tr: 'Ad' },
  'Ед. изм.': { uz: 'O‘lchov birligi', en: 'Unit', tr: 'Birim' },
  'Дата': { uz: 'Sana', en: 'Date', tr: 'Tarih' },
  'Ожидаемая дата получения': { uz: 'Kutilayotgan qabul sanasi', en: 'Expected receipt date', tr: 'Beklenen teslim tarihi' },
  'Назначение и цель': { uz: 'Maqsad va vazifa', en: 'Purpose and goal', tr: 'Amaç ve hedef' },
  'Назначение, склад, срочность, примечания...': { uz: 'Maqsad, ombor, shoshilinchlik, izohlar...', en: 'Purpose, warehouse, urgency, notes...', tr: 'Amaç, depo, aciliyet, notlar...' },
  'Сбросить': { uz: 'Tiklash', en: 'Reset', tr: 'Sıfırla' },
  // ── Seeded system data ───────────────────────────────────────────────────
  // These labels come from the API (system roles, demo structure and the
  // default workflow), so they are not JSX literals and cannot be translated
  // by the component-level `tl()` calls alone. Keep them here as exact values
  // so the DOM observer also localizes data rendered after an API response.
  'Заявитель (сотрудник отдела)': { uz: 'Bo‘lim xodimi (ariza beruvchi)', en: 'Department employee (requester)', tr: 'Departman çalışanı (talep sahibi)' },
  'Склад (кладовщик)': { uz: 'Ombor (omborchi)', en: 'Warehouse (storekeeper)', tr: 'Depo (depo görevlisi)' },
  'Начальник склада': { uz: 'Ombor boshlig‘i', en: 'Warehouse supervisor', tr: 'Depo sorumlusu' },
  'Ген. директор': { uz: 'Bosh direktor', en: 'General director', tr: 'Genel müdür' },
  'Учредитель': { uz: 'Ustavdor', en: 'Founder', tr: 'Kurucu' },
  'Снабжение (отдел)': { uz: 'Ta’minot (bo‘lim)', en: 'Procurement (department)', tr: 'Satın alma (departman)' },
  'Снабжение': { uz: 'Ta’minot', en: 'Procurement', tr: 'Satın alma' },
  'Финансист': { uz: 'Moliyachi', en: 'Finance specialist', tr: 'Finans uzmanı' },
  'Работник склада': { uz: 'Ombor xodimi', en: 'Warehouse worker', tr: 'Depo çalışanı' },
  'Работник склада, Assistant': { uz: 'Ombor xodimi, Assistant', en: 'Warehouse worker, Assistant', tr: 'Depo çalışanı, Assistant' },
  'Руководитель финансов': { uz: 'Moliya rahbari', en: 'Finance head', tr: 'Finans yöneticisi' },
  'Финансовый менеджер': { uz: 'Moliya menejeri', en: 'Finance manager', tr: 'Finans müdürü' },
  'Бухгалтер': { uz: 'Buxgalter', en: 'Accountant', tr: 'Muhasebeci' },
  'Руководитель внедрения': { uz: 'Joriy etish rahbari', en: 'Operations lead', tr: 'Uygulama yöneticisi' },
  'Аудитор': { uz: 'Auditor', en: 'Auditor', tr: 'Denetçi' },
  'Наблюдатель': { uz: 'Kuzatuvchi', en: 'Observer', tr: 'Gözlemci' },
  'Исполнительный директор': { uz: 'Ijrochi direktor', en: 'Executive director', tr: 'İcra direktörü' },
  'Тестовый завод №1': { uz: '1-son sinov zavodi', en: 'Test factory No. 1', tr: '1 No’lu test fabrikası' },
  'Основной склад (тест)': { uz: 'Asosiy ombor (sinov)', en: 'Main warehouse (test)', tr: 'Ana depo (test)' },
  'Тестовый маршрут (полный)': { uz: 'Sinov marshruti (to‘liq)', en: 'Test workflow (full)', tr: 'Test iş akışı (tam)' },
  'Подтверждение начальника склада': { uz: 'Ombor boshlig‘ini tasdiqlash', en: 'Warehouse supervisor approval', tr: 'Depo sorumlusu onayı' },
  'Снабжение — предложение': { uz: 'Ta’minot — taklif', en: 'Procurement — quotation', tr: 'Satın alma — teklif' },
  'Снабжение — менеджер': { uz: 'Ta’minot — menejer', en: 'Procurement — manager', tr: 'Satın alma — müdür' },
  'Одобрение ген. директора': { uz: 'Bosh direktor tasdig‘i', en: 'General director approval', tr: 'Genel müdür onayı' },
  'Утверждение учредителя': { uz: 'Ustavdor tasdig‘i', en: 'Founder approval', tr: 'Kurucu onayı' },
  'Прибытие товара на склад': { uz: 'Tovar omborga yetib kelishi', en: 'Goods arrival at warehouse', tr: 'Ürünün depoya ulaşması' },
  'Склад назначения': { uz: 'Belgilangan ombor', en: 'Destination warehouse', tr: 'Hedef depo' },
  'Назначение / цель': { uz: 'Maqsad / vazifa', en: 'Purpose / goal', tr: 'Amaç / hedef' },
  'Происхождение': { uz: 'Kelib chiqishi', en: 'Origin', tr: 'Menşei' },
  'Степень срочности': { uz: 'Shoshilinchlik darajasi', en: 'Urgency level', tr: 'Aciliyet düzeyi' },
  'Необходимо к дате': { uz: 'Kerakli sana', en: 'Required by date', tr: 'Gerekli tarih' },
  'Код товара': { uz: 'Mahsulot kodi', en: 'Product code', tr: 'Ürün kodu' },
  'Тестовый маршрут (полный) • активен': { uz: 'Sinov marshruti (to‘liq) • faol', en: 'Test workflow (full) • active', tr: 'Test iş akışı (tam) • aktif' },
  'Обычный вход внутри Telegram. В тестовой среде — через телефон или тестовый логин.': { uz: 'Telegram ichida odatiy kirish. Sinov muhitida — telefon yoki test logini orqali.', en: 'Sign in normally inside Telegram. In the test environment, use a phone number or test login.', tr: 'Telegram içinde normal giriş. Test ortamında telefon numarası veya test kullanıcı adı kullanın.' },
  'Телефон или тестовый логин': { uz: 'Telefon yoki test logini', en: 'Phone or test login', tr: 'Telefon veya test kullanıcı adı' },
  'Ожидает действия': { uz: 'Harakatni kutmoqda', en: 'Awaiting action', tr: 'İşlem bekliyor' },
  'Ожидает доставки': { uz: 'Yetkazishni kutmoqda', en: 'Awaiting delivery', tr: 'Teslimat bekliyor' },
  'Ожидает подтверждения получения': { uz: 'Qabul tasdig‘ini kutmoqda', en: 'Awaiting receipt confirmation', tr: 'Teslimat onayını bekliyor' },
  'Просрочено': { uz: 'Muddati o‘tgan', en: 'Overdue', tr: 'Süresi geçmiş' },
  'Прочитано': { uz: 'O‘qilgan', en: 'Read', tr: 'Okundu' },
  'Ждёт вас': { uz: 'Sizni kutmoqda', en: 'Waiting for you', tr: 'Sizi bekliyor' },
  'Отправляется': { uz: 'Yuborilmoqda', en: 'Sending', tr: 'Gönderiliyor' },
  'Поставка доставлена': { uz: 'Yetkazib berildi', en: 'Delivery received', tr: 'Teslimat ulaştı' },
  'Заказ отправлен': { uz: 'Buyurtma yuborildi', en: 'Order dispatched', tr: 'Sipariş gönderildi' },
  'Материал принят на склад': { uz: 'Material omborga qabul qilindi', en: 'Material received into warehouse', tr: 'Malzeme depoya alındı' },
  'Материал выдан со склада': { uz: 'Material ombordan berildi', en: 'Material issued from warehouse', tr: 'Malzeme depodan çıkarıldı' },
  'Склад должен проверить наличие': { uz: 'Ombor mavjudlikni tekshirishi kerak', en: 'Warehouse must check availability', tr: 'Depo stok durumunu kontrol etmeli' },
  'Склад должен выдать материал': { uz: 'Ombor materialni berishi kerak', en: 'Warehouse must issue the material', tr: 'Depo malzemeyi çıkarmalı' },
  'Склад принимает товар': { uz: 'Ombor tovarni qabul qiladi', en: 'Warehouse receives the goods', tr: 'Depo ürünü teslim alır' },
  'Снабжение подбирает поставщика': { uz: 'Ta’minot yetkazib beruvchini tanlamoqda', en: 'Procurement is selecting a supplier', tr: 'Satın alma tedarikçi seçiyor' },
  'Этап пройден': { uz: 'Bosqich o‘tildi', en: 'Step completed', tr: 'Aşama tamamlandı' },
  'Возврат на этап': { uz: 'Bosqichga qaytarish', en: 'Return to step', tr: 'Aşamaya geri dön' },
  'Включено': { uz: 'Yoqilgan', en: 'On', tr: 'Açık' },
  'Выключено': { uz: 'O‘chirilgan', en: 'Off', tr: 'Kapalı' },
  'Вкл': { uz: 'Yoqilgan', en: 'On', tr: 'Açık' },
  'Выкл': { uz: 'O‘chirilgan', en: 'Off', tr: 'Kapalı' },
  'Да': { uz: 'Ha', en: 'Yes', tr: 'Evet' },
  'нет': { uz: 'yo‘q', en: 'no', tr: 'hayır' },
  'Не выбрано': { uz: 'Tanlanmagan', en: 'Not selected', tr: 'Seçilmedi' },
  'Не назначен': { uz: 'Tayinlanmagan', en: 'Not assigned', tr: 'Atanmadı' },
  'Любой': { uz: 'Istalgan', en: 'Any', tr: 'Herhangi' },
  'Не важно': { uz: 'Farqi yo‘q', en: 'Does not matter', tr: 'Fark etmez' },
  'без роли': { uz: 'ro‘lsiz', en: 'no role', tr: 'rol yok' },
  'система': { uz: 'tizim', en: 'system', tr: 'sistem' },
  'склад': { uz: 'ombor', en: 'warehouse', tr: 'depo' },
  'отдел': { uz: 'bo‘lim', en: 'department', tr: 'bölüm' },
  'завод': { uz: 'zavod', en: 'factory', tr: 'fabrika' },
  'Администратор': { uz: 'Administrator', en: 'Administrator', tr: 'Yönetici' },
  'Выбран поставщик': { uz: 'Tanlangan yetkazib beruvchi', en: 'Supplier selected', tr: 'Seçilen tedarikçi' },
  'Добавлено КП': { uz: 'Taklif qo‘shildi', en: 'Offer added', tr: 'Teklif eklendi' },
  'Завод создан': { uz: 'Zavod yaratildi', en: 'Factory created', tr: 'Fabrika oluşturuldu' },
  'Завод удалён': { uz: 'Zavod o‘chirildi', en: 'Factory deleted', tr: 'Fabrika silindi' },
  'Загрузка...': { uz: 'Yuklanmoqda...', en: 'Loading...', tr: 'Yükleniyor...' },
  'Заведение': { uz: 'Yaratish', en: 'Create', tr: 'Oluştur' },
  'Заявка создана': { uz: 'Ariza yaratildi', en: 'Request created', tr: 'Talep oluşturuldu' },
  'Заявка удалена': { uz: 'Ariza o‘chirildi', en: 'Request deleted', tr: 'Talep silindi' },
  'Материал создан': { uz: 'Mahsulot yaratildi', en: 'Material created', tr: 'Malzeme oluşturuldu' },
  'Материал удалён': { uz: 'Mahsulot o‘chirildi', en: 'Material deleted', tr: 'Malzeme silindi' },
  'Набор прав изменён': { uz: 'Huquqlar o‘zgartirildi', en: 'Permission set changed', tr: 'Yetki seti değiştirildi' },
  'Набор прав удалён': { uz: 'Huquqlar o‘chirildi', en: 'Permission set deleted', tr: 'Yetki seti silindi' },
  'Недоступно': { uz: 'Mavjud emas', en: 'Unavailable', tr: 'Kullanılamıyor' },
  'Отдел удалён': { uz: 'Bo‘lim o‘chirildi', en: 'Department deleted', tr: 'Bölüm silindi' },
  'Ожидает согласования': { uz: 'Tasdiqlashni kutmoqda', en: 'Waiting for approval', tr: 'Onay bekliyor' },
  'Ожидают оплаты': { uz: 'To‘lovni kutmoqda', en: 'Awaiting payment', tr: 'Ödeme bekleniyor' },
  'Поле формы создано': { uz: 'Forma maydoni yaratildi', en: 'Form field created', tr: 'Form alanı oluşturuldu' },
  'Поле формы удалено': { uz: 'Forma maydoni o‘chirildi', en: 'Form field deleted', tr: 'Form alanı silindi' },
  'Права добавлены': { uz: 'Huquqlar qo‘shildi', en: 'Permissions added', tr: 'Yetkiler eklendi' },
  'Пользователь добавлен': { uz: 'Foydalanuvchi qo‘shildi', en: 'User added', tr: 'Kullanıcı eklendi' },
  'Пользователь удалён': { uz: 'Foydalanuvchi o‘chirildi', en: 'User removed', tr: 'Kullanıcı silindi' },
  'Пользователь архивирован': { uz: 'Foydalanuvchi arxivlandi', en: 'User archived', tr: 'Kullanıcı arşivlendi' },
  'Пользователь восстановлен': { uz: 'Foydalanuvchi tiklandi', en: 'User restored', tr: 'Kullanıcı geri yüklendi' },
  'Склад удалён': { uz: 'Ombor o‘chirildi', en: 'Warehouse deleted', tr: 'Depo silindi' },
  'Согласующий': { uz: 'Tasdiqlovchi', en: 'Approver', tr: 'Onaycı' },
  'Сотрудник': { uz: 'Xodim', en: 'Employee', tr: 'Çalışan' },
  'Сотрудники': { uz: 'Xodimlar', en: 'Employees', tr: 'Çalışanlar' },
  'Безопасность': { uz: 'Xavfsizlik', en: 'Security', tr: 'Güvenlik' },
  'Ваше имя': { uz: 'Ismingiz', en: 'Your name', tr: 'Adınız' },
  'Вложения:': { uz: 'Biriktirmalar:', en: 'Attachments:', tr: 'Ekler:' },
  'Должность': { uz: 'Lavozim', en: 'Position', tr: 'Pozisyon' },
  'Загрузка': { uz: 'Yuklanmoqda', en: 'Loading', tr: 'Yükleniyor' },
  'Настройка': { uz: 'Sozlama', en: 'Setting', tr: 'Ayar' },
  'Новое': { uz: 'Yangi', en: 'New', tr: 'Yeni' },
  'По позициям': { uz: 'Pozitsiyalar bo‘yicha', en: 'By items', tr: 'Kalem bazında' },
  'Позиций': { uz: 'Pozitsiyalar', en: 'Items', tr: 'Kalemler' },
  'Передать снабженцу': { uz: 'Ta’minotchiga topshiring', en: 'Assign to procurement', tr: 'Satın almaya aktar' },
  'Принять в работу': { uz: 'Ishga qabul qilish', en: 'Take to work', tr: 'İşe al' },
  'Проверьте заявку': { uz: 'Arizani tekshiring', en: 'Please check the request', tr: 'Talebi kontrol et' },
  'Сводка': { uz: 'Xulosa', en: 'Summary', tr: 'Özet' },
  'Сумма': { uz: 'Summa', en: 'Amount', tr: 'Tutar' },
  'Телефон': { uz: 'Telefon', en: 'Phone', tr: 'Telefon' },
  'Удалить заявку? Отменить это действие будет нельзя.': { uz: 'Arizani o‘chirilsinmi? Bu amalni bekor qilib bo‘lmaydi.', en: 'Delete request? This action cannot be undone.', tr: 'Talep silinsin mi? Bu işlem geri alınamaz.' },
  'Файл ': { uz: 'Fayl ', en: 'File ', tr: 'Dosya ' },
  'Файл больше 2 МБ': { uz: 'Fayl 2 MB dan katta', en: 'File is over 2 MB', tr: 'Dosya 2 MB’dan büyük' },
  'ID материала (каталог пуст)': { uz: 'Material ID (katalog bo‘sh)', en: 'Material ID (catalog empty)', tr: 'Malzeme ID (katalog boş)' },
  'ID склада (необязательно)': { uz: 'Ombor ID (majburiy emas)', en: 'Warehouse ID (optional)', tr: 'Depo ID (zorunlu değil)' },
  'Файл больше 2 Мб': { uz: 'Fayl 2 MB dan katta', en: 'File is over 2 MB', tr: 'Dosya 2 MB’dan büyük' },
  'Файл больше 2 mb': { uz: 'Fayl 2 MB dan katta', en: 'File is over 2 MB', tr: 'Dosya 2 MB’dan büyük' },
  'Файл больше 2 мб': { uz: 'Fayl 2 MB dan katta', en: 'File is over 2 MB', tr: 'Dosya 2 MB’dan büyük' },
  'больше 2 МБ': { uz: '2 MB dan katta', en: 'bigger than 2 MB', tr: '2 MB’dan büyük' },
  'больше 2 Мб': { uz: '2 MB dan katta', en: 'bigger than 2 MB', tr: '2 MB’dan büyük' },
  'больше 2 mb': { uz: '2 MB dan katta', en: 'bigger than 2 MB', tr: '2 MB’dan büyük' },
  'больше 2 мб': { uz: '2 MB dan katta', en: 'bigger than 2 MB', tr: '2 MB’dan büyük' },
  'Экспорт в Excel (CSV)': { uz: 'Excel (CSV) ga eksport', en: 'Export to Excel (CSV)', tr: 'Excel (CSV) olarak dışa aktar' },
  'напр. Инженер': { uz: 'masalan, Muhandis', en: 'e.g., Engineer', tr: 'ör. Mühendis' },
  'Минус': { uz: 'Minus', en: 'Minus', tr: 'Eksi' },
  'Плюс': { uz: 'Plus', en: 'Plus', tr: 'Artı' },
  'Наличные': { uz: 'Naqd', en: 'Cash', tr: 'Nakit' },
  'Перечисление': { uz: 'Pul o‘tkazmasi', en: 'Transfer', tr: 'Transfer' },
  'Сотрудник (необязательно)': { uz: 'Xodim (ixtiyoriy)', en: 'Employee (optional)', tr: 'Çalışan (isteğe bağlı)' },
  'Владелец': { uz: 'Egа', en: 'Owner', tr: 'Sahip' },
  'Администраторский': { uz: 'Administrator', en: 'Administrative', tr: 'Yönetsel' },
  'Новый': { uz: 'Yangi', en: 'New', tr: 'Yeni' },
  'Переименовать': { uz: 'Qayta nomlash', en: 'Rename', tr: 'Yeniden adlandır' },
  'напр. Tedarik': { uz: 'masalan, Tedarik', en: 'e.g. Tedarik', tr: 'ör. Tedarik' },
  'напр. Главный завод': { uz: 'masalan, Asosiy zavod', en: 'e.g. Main factory', tr: 'ör. Ana fabrika' },
  'напр. Главный склад': { uz: 'masalan, Asosiy ombor', en: 'e.g. Main warehouse', tr: 'ör. Ana depo' },
  'напр. Снабжение': { uz: 'masalan, Ta’minot', en: 'e.g. Procurement', tr: 'ör. Satın alma' },
  'название': { uz: 'nomi', en: 'name', tr: 'ad' },
  'Пользовательская почта': { uz: 'Foydalanuvchi pochta', en: 'User email', tr: 'Kullanıcı e-postası' },
  'Новый поставщик': { uz: 'Yangi yetkazib beruvchi', en: 'New supplier', tr: 'Yeni tedarikçi' },
  'напр. ООО Поставка': { uz: 'masalan, OOO Yetkazib berish', en: 'e.g. LLC Supply', tr: 'ör. LTD Tedarik' },
  'необязательно': { uz: 'majburiy emas', en: 'optional', tr: 'zorunlu değil' },
  'новый шаг': { uz: 'yangi bosqich', en: 'new step', tr: 'yeni adım' },
  'Ремонт': { uz: 'Ta’mirlash', en: 'Repair', tr: 'Onarım' },
  'Услуга': { uz: 'Xizmat', en: 'Service', tr: 'Hizmet' },
  'Выдать в отдел': { uz: 'Bo‘limga berish', en: 'Issue to department', tr: 'Bölüme ver' },
  'Сохранить порядок': { uz: 'Tartibni saqlash', en: 'Save order', tr: 'Sırayı kaydet' },
  'Удалить шаг?': { uz: 'Qadam o‘chirilsinmi?', en: 'Delete step?', tr: 'Adım silinsin mi?' },
  'без границы': { uz: 'cheklanmagan', en: 'no limit', tr: 'sınır yok' },
  'напр. 5000000': { uz: 'masalan, 5000000', en: 'e.g. 5000000', tr: 'ör. 5000000' },
  'напр. Закупка оборудования': { uz: 'masalan, Uskuna xaridi', en: 'e.g. Equipment procurement', tr: 'ör. Ekipman satın alma' },
  'напр. Финансы': { uz: 'masalan, Moliyala', en: 'e.g. Finance', tr: 'ör. Finans' },
  ' роль': { uz: ' rol', en: ' role', tr: ' rol' },
  '• активна': { uz: '• aktiv', en: '• active', tr: '• aktif' },
  ' (для подписи)': { uz: ' (imzo uchun)', en: ' (for signature)', tr: ' (imza için)' },
  'Отчёты': { uz: 'Hisobotlar', en: 'Reports', tr: 'Raporlar' },
  'Новый набор прав': { uz: 'Yangi huquqlar to‘plami', en: 'New permission set', tr: 'Yeni yetki seti' },
  'Переименовать набор прав': { uz: 'Huquqlar to‘plamini qayta nomlash', en: 'Rename permission set', tr: 'Yetki setini yeniden adlandır' },
  'напр. buyer': { uz: 'masalan, buyer', en: 'e.g. buyer', tr: 'ör. alıcı' },
  'напр. Закупщик': { uz: 'masalan, Xaridchi', en: 'e.g. Procurement buyer', tr: 'ör. Satın alıcı' },
  'PIN-код (подпись)': { uz: 'PIN kod (imzo)', en: 'PIN code (signature)', tr: 'PIN kodu (imza)' },
  'EUR — Евро': { uz: 'EUR — Yevro', en: 'EUR — Euro', tr: 'EUR — Euro' },
  'RUB — Рубль': { uz: 'RUB — Rubl', en: 'RUB — Ruble', tr: 'RUB — Ruble' },
  'USD — Доллар': { uz: 'USD — Dollar', en: 'USD — Dollar', tr: 'USD — Dolar' },
  'UZS — Сум': { uz: 'UZS — So‘m', en: 'UZS — Sum', tr: 'UZS — So‘m' },
  'Выкл. — пуш на каждое событие': { uz: 'O‘chiq — har bir hodisa uchun bildirishnoma', en: 'Off — push for each event', tr: 'Kapalı — her olay için push' },
  'Дайджест уведомлений «Ждёт вас»': { uz: '«Sizni kutmoqda» bildirishnomalari digesti', en: 'Notification digest "Waiting for you"', tr: '«Sizi bekliyor» bildirim özeti' },
  'Обычное подтверждение «Вы уверены?»': { uz: 'Oddiy tasdiqlash: «Ishonchingiz komilmi?»', en: 'Standard confirmation: “Are you sure?”', tr: 'Normal onay: “Emin misiniz?”' },
  'Перечисление, Наличные': { uz: 'Pul o‘tkazmasi, Naqd', en: 'Transfer, Cash', tr: 'Transfer, Nakit' },
  'Подтверждение действий (согласование, оплата)': { uz: 'Amallarni tasdiqlash (tasdiqlash, to‘lov)', en: 'Action confirmation (approval, payment)', tr: 'İşlem onayı (onay, ödeme)' },
  'Сводка раз в 3 часа': { uz: 'Har 3 soatda bir xulosa', en: 'Summary every 3 hours', tr: 'Her 3 saatte bir özet' },
  'Сводка раз в 8 часов': { uz: 'Har 8 soatda bir xulosa', en: 'Summary every 8 hours', tr: 'Her 8 saatte bir özet' },
  'Сводка раз в час': { uz: 'Har soatda bir xulosa', en: 'Summary every hour', tr: 'Her saat özet' },
  'Таймаут шага по умолчанию, часов (эскалация; пусто — выкл.)': { uz: 'Bosqich uchun standart timeout, soat (eskalatsiya; bo‘sh bo‘lsa o‘chiradi)', en: 'Default step timeout in hours (escalation; empty to disable)', tr: 'Varsayılan adım zaman aşımı saat cinsinden (escalation; boşsa kapalı)' },
  'Имя Фамилия': { uz: 'Ism Familiya', en: 'First name Last name', tr: 'Ad Soyad' },
  'Снять права?': { uz: 'Huquqlarni olib tashlash?', en: 'Remove permissions?', tr: 'Yetkiler kaldırılsın mı?' },
  'напр. 8236045489': { uz: 'masalan, 8236045489', en: 'e.g. 8236045489', tr: 'ör. 8236045489' },
  'напр. Сотрудник забыл PIN': { uz: 'masalan, Xodim PINini unutdi', en: 'e.g. Employee forgot PIN', tr: 'ör. Çalışan PINini unuttu' },
  'текст': { uz: 'matn', en: 'text', tr: 'metin' },
  'Многострочный': { uz: 'Ko‘p qatorli', en: 'Multi-line', tr: 'Çok satırlı' },
  'Список выбора': { uz: 'Tanlov ro‘yxati', en: 'Select list', tr: 'Seçim listesi' },
  'Текст': { uz: 'Matn', en: 'Text', tr: 'Metin' },
  'Файл': { uz: 'Fayl', en: 'File', tr: 'Dosya' },
  'Флажок': { uz: 'Belgilash', en: 'Checkbox', tr: 'Onay kutusu' },
  'Число': { uz: 'Raqam', en: 'Number', tr: 'Sayı' },
  'напр. Артикул поставщика': { uz: 'masalan, Yetkazib beruvchi artikuli', en: 'e.g. Supplier item', tr: 'ör. Tedarikçi kalemi' },
  'Новый материал': { uz: 'Yangi material', en: 'New material', tr: 'Yeni malzeme' },
  'напр. BLT-M8-40': { uz: 'masalan, BLT-M8-40', en: 'e.g. BLT-M8-40', tr: 'ör. BLT-M8-40' },
  'напр. Болт М8×40': { uz: 'masalan, Bolt M8×40', en: 'e.g. Bolt M8x40', tr: 'ör. Civata M8×40' },
  'шт, кг, м': { uz: 'dona, kg, m', en: 'pcs, kg, m', tr: 'adet, kg, m' },
  'напр. шт, кг, м': { uz: 'masalan, dona, kg, m', en: 'e.g. pcs, kg, m', tr: 'ör. adet, kg, m' },
  'Новый набор': { uz: 'Yangi to‘plam', en: 'New set', tr: 'Yeni set' },
  'Назначение действий': { uz: 'Harakatni belgilash', en: 'Action assignment', tr: 'Eylem atama' },
  'Отчёт': { uz: 'Hisobot', en: 'Report', tr: 'Rapor' },
  'ждёт 1 день': { uz: '1 kun kutmoqda', en: 'due in 1 day', tr: '1 gün bekliyor' },
  'сегодня': { uz: 'bugun', en: 'today', tr: 'bugün' },
  'Изменить шаг': { uz: 'Qadamni o‘zgartirish', en: 'Edit step', tr: 'Adımı düzenle' },
  'Новая цепочка': { uz: 'Yangi zanjir', en: 'New chain', tr: 'Yeni zincir' },
  'Новый шаг': { uz: 'Yangi qadam', en: 'New step', tr: 'Yeni adım' },
  'По позиции': { uz: 'Pozitsiyalar bo‘yicha', en: 'By position', tr: 'Kalem bazında' },
  'На доработке': { uz: 'Qayta ishlashda', en: 'Needs revision', tr: 'Düzeltilmesi gereken' },
  'Материал:': { uz: 'Material:', en: 'Material:', tr: 'Malzeme:' },
  'Сотрудники:': { uz: 'Xodimlar:', en: 'Employees:', tr: 'Çalışanlar:' },
  'Поле:': { uz: 'Maydon:', en: 'Field:', tr: 'Alan:' },
  'Выдача в отдел': { uz: 'Bo‘limga berish', en: 'Issue to department', tr: 'Bölüme verme' },
  'Новое поле': { uz: 'Yangi maydon', en: 'New field', tr: 'Yeni alan' },
  'напр. 24': { uz: 'masalan, 24', en: 'e.g. 24', tr: 'ör. 24' },
  'напр. Zibrock Factory': { uz: 'masalan, Zibrock Factory', en: 'e.g. Zibrock Factory', tr: 'ör. Zibrock Factory' },
  "напр. Ta'minot": { uz: 'masalan, Ta’minot', en: 'e.g. Ta’minot', tr: 'ör. Ta’minot' },
  'Архивировать': { uz: 'Arxivlash', en: 'Archive', tr: 'Arşivle' },
  'Укажите причину': { uz: 'Sababini kiriting', en: 'Specify a reason', tr: 'Sebep belirtin' },
  'Вариант': { uz: 'Variant', en: 'Option', tr: 'Seçenek' },
  'Нажмите чтобы выбрать файл': { uz: 'Faylni tanlash uchun bosing', en: 'Click to select file', tr: 'Dosya seçmek için tıklayın' },
  'Ошибка': { uz: 'Xatolik', en: 'Error', tr: 'Hata' },
  'Роль': { uz: 'Rol', en: 'Role', tr: 'Rol' },
  'роль': { uz: 'rol', en: 'role', tr: 'rol' },
  ' • активна': { uz: ' • faol', en: ' • active', tr: ' • aktif' },
  '← В приложение': { uz: '← Ilovaga', en: '← In app', tr: '← Uygulamada' },
  'Нет записей в журнале аудита.': { uz: 'Auditoriya jurnalida yozuvlar yo‘q.', en: 'No audit log entries yet.', tr: 'Denetim günlüğünde kayıt yok.' },
  '+ Вариант': { uz: '+ Variant', en: '+ Option', tr: '+ Seçenek' },
  '+ Добавить поле': { uz: '+ Maydon qo‘shish', en: '+ Add field', tr: '+ Alan ekle' },
  '+ Добавить шаг': { uz: '+ Qadam qo‘shish', en: '+ Add step', tr: '+ Adım ekle' },
  '➕ Новый шаг': { uz: '➕ Yangi qadam', en: '➕ New step', tr: '➕ Yeni adım' },
  'Варианты выбора (кнопки)': { uz: 'Variantlar (tugmalar)', en: 'Option variants (buttons)', tr: 'Seçenek varyantları (düğmeler)' },
  'выключено': { uz: 'o‘chirildi', en: 'off', tr: 'kapalı' },
  'На каком шаге': { uz: 'Qaysi qadamda', en: 'On which step', tr: 'Hangi adımda' },
  'Название поля': { uz: 'Maydon nomi', en: 'Field name', tr: 'Alan adı' },
  'обязательное': { uz: 'majburiy', en: 'required', tr: 'zorunlu' },
  'Обязательное': { uz: 'Majburiy', en: 'Required', tr: 'Zorunlu' },
  'Обязательное поле': { uz: 'Majburiy maydon', en: 'Required field', tr: 'Zorunlu alan' },
  'Показывать в форме': { uz: 'Shaklda ko‘rsatish', en: 'Show in form', tr: 'Formda göster' },
  'своё': { uz: 'o‘z', en: 'custom', tr: 'özel' },
  'Системное поле: нельзя поменять только тип. Название, варианты-кнопки, обязательность, видимость и шаг — можно.': { uz: 'Tizim maydoni: faqat turini o‘zgartirib bo‘lmaydi. Nomi, tugma variantlari, majburiylik, ko‘rinish va qadamni o‘zgartirish mumkin.', en: 'System field: only the type cannot be changed. Name, button options, requiredness, visibility and step can be changed.', tr: 'Sistem alanı: yalnızca türü değiştirilemez. İsim, düğme seçenekleri, zorunluluk, görünürlük ve adım değiştirilebilir.' },
  'Тип поля': { uz: 'Maydon turi', en: 'Field type', tr: 'Alan türü' },
  'Шаги — это экраны мастера при создании заявки. Внутри шага добавляй поля кнопкой «+ Добавить поле». Новый шаг — кнопкой «+ Добавить шаг» внизу. Поля можно удалять, выключать и переносить между шагами.': { uz: 'Qadamlar — bu ariza yaratishdagi ustun ekrandir. Har bir qadam ichida «+ Maydon qo‘shish» tugmasi bilan maydon qo‘shiladi. Yangi qadamni pastdagi «+ Qadam qo‘shish» tugmasi bilan yarating. Maydonlarni o‘chirish, o‘chirishni o‘chirish va qadamlar o‘rtasida ko‘chirish mumkin.', en: 'Steps are screens of the request creation wizard. Add fields with “+ Add field”, add new steps with “+ Add step” at the bottom. Fields can be deleted, turned off and moved between steps.', tr: 'Adımlar, talep oluşturma sihirbazının ekranlarıdır. Her adım içinde “+ Alan ekle” düğmesiyle alan eklenir. Yeni adım alttaki “+ Adım ekle” düğmesiyle eklenir. Alanlar silinebilir, kapatılabilir ve adımlar arasında taşınabilir.' },
  '+ Добавить материал': { uz: '+ Material qo‘shish', en: '+ Add material', tr: '+ Malzeme ekle' },
  'Артикул / SKU': { uz: 'Artikul / SKU', en: 'SKU', tr: 'Ürün kodu' },
  'Артикул / SKU (необязательно)': { uz: 'Artikul / SKU (majburiy emas)', en: 'SKU (optional)', tr: 'SKU (isteğe bağlı)' },
  'Единица измерения': { uz: 'O‘lchov birligi', en: 'Unit of measure', tr: 'Ölçü birimi' },
  'Материалов нет. Добавьте первый.': { uz: 'Hech qanday material yo‘q. Birinchi materialni qo‘shing.', en: 'No materials yet. Add the first one.', tr: 'Henüz malzeme yok. İlkini ekleyin.' },
  '+ Добавить': { uz: '+ Qo‘shish', en: '+ Add', tr: '+ Ekle' },
  'Все отделы': { uz: 'Barcha bo‘limlar', en: 'All departments', tr: 'Tüm bölümler' },
  'Выберите права': { uz: 'Huquqni tanlang', en: 'Choose permissions', tr: 'Yetkiyi seçin' },
  'Отдел (область прав)': { uz: 'Bo‘lim (huquq sohasi)', en: 'Department (permission scope)', tr: 'Bölüm (izin kapsamı)' },
  'Отдел (область)': { uz: 'Bo‘lim (soha)', en: 'Department (scope)', tr: 'Bölüm (alan)' },
  'получит уведомление и задаст новый PIN в своём профиле.': { uz: 'Bildirishnoma oladi va profilida yangi PIN o‘rnatadi.', en: 'will receive a notification and will set a new PIN in their profile.', tr: 'bildirim alır ve profilinde yeni PIN belirler.' },
  'Права (необязательно)': { uz: 'Huquqlar (majburiy emas)', en: 'Permissions (optional)', tr: 'İzinler (isteğe bağlı)' },
  'PIN будет стёрт (новый не назначается) — пользователь задаст его заново сам. Действие попадёт в аудит.': { uz: 'PIN o‘chiriladi (yangi belgilangan bo‘lmaydi) — foydalanuvchi uni o‘z profilinga qayta o‘rnatadi. Harakat audit jurnaliga yoziladi.', en: 'PIN will be removed (a new one will not be set) — the user will set it again in their profile. The action will be logged in the audit trail.', tr: 'PIN silinecek (yeni bir PIN atanmayacak) — kullanıcı kendi profilinde yeniden belirleyecektir. İşlem denetim günlüğüne kaydedilecek.' },
  'PIN сброшен.': { uz: 'PIN tozalandi.', en: 'PIN reset.', tr: 'PIN sıfırlandı.' },
  'Удалить все': { uz: 'Barchasini o‘chirish', en: 'Delete all', tr: 'Tümünü sil' },
  '+ Создать набор прав': { uz: '+ Huquq to‘plamini yaratish', en: '+ Create permission set', tr: '+ Yetki seti oluştur' },
  'Код (латиницей)': { uz: 'Kod (lotin yozuvida)', en: 'Code (Latin)', tr: 'Kod (Latin)' },
  'прав': { uz: 'huquq', en: 'permissions', tr: 'yetki' },
  'Ролей нет.': { uz: 'Rollar yo‘q.', en: 'No roles.', tr: 'Rol yok.' },
  'системная': { uz: 'tizimli', en: 'system', tr: 'sistem' },
  'Создавать и менять роли может только super admin.': { uz: 'Rol’larni faqat super admin yaratishi va o‘zgartirishi mumkin.', en: 'Only a super admin can create and edit roles.', tr: 'Rolleri yalnızca super admin oluşturup düzenleyebilir.' },
  'только просмотр': { uz: 'faqat ko‘rish', en: 'view only', tr: 'yalnızca görüntüleme' },
  'Без завода (на уровне холдинга)': { uz: 'Zavodsiz (holding darajasida)', en: 'No factory (holding level)', tr: 'Fabrika yok (holding seviyesi)' },
  'Название (TR)': { uz: 'Nomi (TR)', en: 'Name (TR)', tr: 'Ad (TR)' },
  'Название (UZ)': { uz: 'Nomi (UZ)', en: 'Name (UZ)', tr: 'Ad (UZ)' },
  'отд.': { uz: 'bo‘lim', en: 'depts', tr: 'bölüm' },
  'чел.': { uz: 'kishi', en: 'people', tr: 'kişi' },
  '(для подписи)': { uz: ' (imzo uchun)', en: ' (for signature)', tr: ' (imza için)' },
  '+ Цепочка': { uz: '+ Zanjir', en: '+ Chain', tr: '+ Zincir' },
  'Активна': { uz: 'Aktiv', en: 'Active', tr: 'Aktif' },
  'Сделать активной': { uz: 'Faol qilish', en: 'Make active', tr: 'Aktif yap' },
  'Шаги согласования': { uz: 'Tasdiqlash qadamlari', en: 'Approval steps', tr: 'Onay adımları' },
  'Сначала сохраните порядок — затем можно добавлять и менять шаги.': { uz: 'Avval tartibni saqlang, so‘ng qadamlarni qo‘shish va o‘zgartirish mumkin.', en: 'Save order first, then you can add and edit steps.', tr: 'Önce sırayı kaydedin, sonra adımları ekleyip değiştirebilirsiniz.' },
  'В этой цепочке нет шагов.': { uz: 'Bu zanjirda qadamlar yo‘q.', en: 'There are no steps in this chain.', tr: 'Bu zincirde adım yok.' },
  'Выполнено': { uz: 'Bajarildi', en: 'Completed', tr: 'Tamamlandı' },
  'от': { uz: 'dan', en: 'from', tr: 'dan' },
  'до': { uz: 'gacha', en: 'to', tr: 'kadar' },
  'если в наличии': { uz: 'mavjud bo‘lsa', en: 'if in stock', tr: 'stokta ise' },
  'если нет в наличии': { uz: 'mavjud bo‘lmasa', en: 'if not in stock', tr: 'stokta bo‘lmasa' },
  '✕ → на доработку': { uz: '✕ → qayta ishlashga', en: '✕ → to revision', tr: '✕ → revizyona' },
  '✕ → на шаг': { uz: '✕ → qadamga', en: '✕ → to step', tr: '✕ → adıma' },
  'Название шага': { uz: 'Qadam nomi', en: 'Step name', tr: 'Adım adı' },
  'Определяет, что происходит на шаге и какие действия доступны.': { uz: 'Ushbu qadamda nima bo‘lishi va qaysi harakatlar mumkinligini aniqlaydi.', en: 'Defines what happens in the step and which actions are available.', tr: 'Bu adımda nelerin olacağını ve hangi eylemlerin kullanılabileceğini belirler.' },
  'Кто согласует': { uz: 'Kim tasdiqlaydi', en: 'Who approves', tr: 'Kim onaylar' },
  'Условия включения шага': { uz: 'Qadamni qo‘shish shartlari', en: 'Step inclusion conditions', tr: 'Adım dahil etme koşulları' },
  'Шаг попадает в маршрут, только если ВСЕ заданные условия выполнены. Пустое поле — условие не проверяется.': { uz: 'Qadam marshrutga faqat barcha belgilangan shartlar bajarilganda kiradi. Bo‘sh maydon — shart tekshirilmaydi.', en: 'A step is included in the route only if all specified conditions are met. Empty field means condition is not checked.', tr: 'Bir adım sadece tüm belirlenen koşullar sağlanırsa rotaya girer. Boş alan — koşul kontrol edilmez.' },
  'Если отклонил': { uz: 'Agar rad etgan bo‘lsa', en: 'If rejected', tr: 'Reddederse' },
  'На какой шаг вернуть': { uz: 'Qaysi qadamga qaytarish', en: 'Return to which step', tr: 'Hangi adıma geri dönülecek' },
  'Выберите шаг': { uz: 'Qadamni tanlang', en: 'Choose step', tr: 'Adımı seçin' },
  'Отменить заявку (отклонена окончательно)': { uz: 'Talabni bekor qilish (yakuniy rad etish)', en: 'Cancel request (rejection final)', tr: 'Talebi iptal et (kesin reddi)' },
  'Вернуть заявителю на доработку': { uz: 'Talab qiluvchiga qaytarish', en: 'Return to requester for revision', tr: 'Talep sahibine revizyona gönder' },
  'Вернуть на более ранний шаг…': { uz: 'Oldingi qadamga qaytarish…', en: 'Return to earlier step…', tr: 'Daha erken adıma geri dön…' },
  'Заявка получит статус «На доработке»: автор сможет исправить её и отправить повторно — маршрут начнётся заново.': { uz: 'Ariza «Qayta ishlash» holatiga o‘tadi: muallif uni to‘g‘rilab, qayta yuborishi mumkin. Marshrut qayta boshlanadi.', en: 'The request gets status “Needs revision”: the author can fix and resubmit it, and the route starts again.', tr: 'Talep “Düzeltme gerekiyor” durumunu alır: sahibinin düzenleyip tekrar göndermesi mümkün olur ve akış yeniden başlar.' },
  'Работает после шага «Проверка склада» — например, закупка нужна только когда товара нет.': { uz: 'Bu qadam «Ombor tekshiruvi»dan keyin ishlaydi — masalan, mahsulot bo‘lmasa xarid kerak bo‘lsin.', en: 'Works after “Warehouse check” step — for example, purchasing is needed only when goods are out of stock.', tr: 'Bu adım “Depo kontrolü”nden sonra çalışır — örneğin yalnızca ürün yoksa satın alma gerekir.' },
  'Тип шага': { uz: 'Qadam turi', en: 'Step type', tr: 'Adım türü' },
  'тип:': { uz: 'tur:', en: 'type:', tr: 'tür:' },
  'Сумма от, UZS': { uz: 'Summa: min, UZS', en: 'Amount from, UZS', tr: 'Tutar, UZS (minimum)' },
  'Сумма до, UZS': { uz: 'Summa gacha, UZS', en: 'Amount to, UZS', tr: 'Tutar, UZS' },
  'Наличие на складе': { uz: 'Omborda mavjud', en: 'In stock', tr: 'Stokta var' },
  'Только если ЕСТЬ в наличии': { uz: 'Faqat mavjud bo‘lsa', en: 'Only if in stock', tr: 'Yalnızca stokta varsa' },
  'Только если НЕТ в наличии': { uz: 'Faqat mavjud bo‘lmasa', en: 'Only if not in stock', tr: 'Yalnızca stokta yoksa' },
  'Нельзя перейти на шаг': { uz: 'Qadamga o‘tib bo‘lmadi', en: 'Cannot move to step', tr: 'Adıma geçilemez' },
  'Сумма КП (UZS)': { uz: 'Taklif summasi (UZS)', en: 'Offer amount (UZS)', tr: 'Teklif tutarı (UZS)' },
  'Дата ожидаемого получения не может быть в прошлом:': { uz: 'Kutilgan qabul sanasi o‘tmishda bo‘lishi mumkin emas:', en: 'Expected receiving date cannot be in the past:', tr: 'Beklenen teslim tarihi geçmişte olamaz:' },
  'Шаг': { uz: 'Bosqich', en: 'Step', tr: 'Adım' },
  'Позиция': { uz: 'Pozitsiya', en: 'Item', tr: 'Kalem' },
  'Срок': { uz: 'Muddat', en: 'Deadline', tr: 'Süre' },
  'Срок:': { uz: 'Muddat:', en: 'Term:', tr: 'Süre:' },
  'срок:': { uz: 'muddat:', en: 'term:', tr: 'süre:' },
  'Продукты': { uz: 'Mahsulotlar', en: 'Products', tr: 'Ürünler' },
  '✓ В наличии': { uz: '✓ Mavjud', en: '✓ In stock', tr: '✓ Stokta var' },
  '✓ выбран': { uz: '✓ Tanlangan', en: '✓ Selected', tr: '✓ Seçildi' },
  '✗ Нет — в закупку': { uz: '✗ Yo‘q — xaridga', en: '✗ No — to purchasing', tr: '✗ Yok — satın almaya' },
  'Позиция:': { uz: 'Pozitsiya:', en: 'Position:', tr: 'Pozisyon:' },
  'из': { uz: 'dan', en: 'of', tr: 'dan' },
  'продукты': { uz: 'mahsulotlar', en: 'products', tr: 'ürünler' },
  'Аудит-лог': { uz: 'Audit jurnali', en: 'Audit log', tr: 'Denetim günlüğü' },
  'Вложения ·': { uz: 'Biriktirmalar ·', en: 'Attachments ·', tr: 'Ekler ·' },
  'все →': { uz: 'hammasi →', en: 'all →', tr: 'tümü →' },
  'Не удалось загрузить:': { uz: 'Yuklab bo‘lmadi:', en: 'Could not load:', tr: 'Yüklenemedi:' },
  'Не удалось загрузить дашборд:': { uz: 'Boshqaruv panelini yuklab bo‘lmadi:', en: 'Could not load dashboard:', tr: 'Gösterge paneli yüklenemedi:' },
  'Не удалось загрузить уведомления:': { uz: 'Bildirishnomalarni yuklab bo‘lmadi:', en: 'Could not load notifications:', tr: 'Bildirimler yüklenemedi:' },
  'Уведомлений пока нет.': { uz: 'Hozircha bildirishnomalar yo‘q.', en: 'No notifications yet.', tr: 'Henüz bildirim yok.' },
  'Пуш в Telegram не дошёл — уведомление доступно здесь': { uz: 'Telegram push o‘tib qolmadi — bu yerda bildirishnoma mavjud', en: 'Telegram push did not arrive — notification is available here', tr: 'Telegram push geçmedi — bildirim burada mevcuttur' },
  '· прочитано': { uz: '· o‘qildi', en: '· read', tr: '· okundu' },
  'К заявке': { uz: 'Talabga', en: 'To request', tr: 'Talebe' },
  'История действий (аудит)': { uz: 'Harakatlar tarixi (audit)', en: 'Action history (audit)', tr: 'Eylem geçmişi (denetim)' },
  'Информация о заявке': { uz: 'Ariza haqida ma’lumot', en: 'Request information', tr: 'Talep bilgisi' },
  'Прочитать все': { uz: 'Barchasini o‘qish', en: 'Read all', tr: 'Hepsini oku' },
  'Нет данных': { uz: 'Ma’lumot yo‘q', en: 'No data', tr: 'Veri yok' },
  'Прав': { uz: 'Ruxsat', en: 'Right', tr: 'Hak' },
  'Разрешить': { uz: 'Ruxsat berish', en: 'Allow', tr: 'İzin ver' },
  'Склады ещё не настроены. Добавьте их в админке → «Структура».': { uz: 'Hozircha omborlar sozlanmagan. Admin panelida «Tüzilmа» bo‘limiga qo‘shing.', en: 'Warehouses are not configured yet. Add them in Admin → «Structure».', tr: 'Depolar henüz yapılandırılmamış. Admindeki «Yapı» bölümüne ekleyin.' },
  '(необязательно)': { uz: '(majburiy emas)', en: '(optional)', tr: '(isteğe bağlı)' },
  '— выберите —': { uz: '— tanlang —', en: '— choose —', tr: '— seçin —' },
  '— не выбран —': { uz: '— tanlanmagan —', en: '— not selected —', tr: '— seçilmedi —' },
  '— не выбрано —': { uz: '— tanlanmadi —', en: '— not selected —', tr: '— seçilmedi —' },
  '— заполните': { uz: '— to‘ldiring', en: '— fill in', tr: '— doldurun' },
  '— дата в прошлом, выберите сегодня или позже': { uz: '— sana o‘tgan, bugun yoki keyinroq tanlang', en: '— date is in the past, choose today or later', tr: '— tarih geçmişte, bugün veya daha sonraki tarihi seçin' },
  'Данные с запросом': { uz: 'So‘rov bilan ma’lumotlar', en: 'Data with request', tr: 'Talep ile veriler' },
  'Другое...': { uz: 'Boshqa...', en: 'Other...', tr: 'Diğer...' },
  'Заполните обязательные поля:': { uz: 'Majburiy maydonlarni to‘ldiring:', en: 'Fill in required fields:', tr: 'Gerekli alanları doldurun:' },
  'Форма создания заявки ещё не настроена. Добавьте поля в админке → «Форма заявки».': { uz: 'Ariza yaratish shakli sozlanmagan. Admin panelidan «So‘rov shakli»ga maydonlar qo‘shing.', en: 'Request creation form is not configured yet. Add fields in Admin → «Request form».', tr: 'Talep oluşturma formu henüz yapılandırılmadı. Admindeki «Talep formu»na alan ekleyin.' },
  'DEV MODE — пользователь этого окна · PIN:': { uz: 'DEV REJIMI — bu oynaning foydalanuvchisi · PIN:', en: 'DEV MODE — user of this window · PIN:', tr: 'DEV MODU — bu pencerenin kullanıcısı · PIN:' },
  'Override — решение мимо оставшихся шагов': { uz: 'Override — qolgan qadamlardan tashqari qaror', en: 'Override — bypass remaining steps', tr: 'Override — kalan adımları atla' },
  'Тестовые пользователи': { uz: 'Sinov foydalanuvchilari', en: 'Test users', tr: 'Test kullanıcılar' },
  'Отдел сноски': { uz: 'Eslatma bo‘limi', en: 'Reference department', tr: 'Dipnot bölümü' },
  'право': { uz: 'huquq', en: 'right', tr: 'hak' },
  'создана': { uz: 'yaratilgan', en: 'created', tr: 'oluşturuldu' },
  'позиций:': { uz: 'pozitsiyalar:', en: 'items:', tr: 'kalemler:' },
  'Архив': { uz: 'Arxiv', en: 'Archive', tr: 'Arşiv' },
  'Объект:': { uz: 'Obyekt:', en: 'Object:', tr: 'Nesne:' },
  'Отдел снабжения:': { uz: 'Ta’minot bo‘limi:', en: 'Procurement department:', tr: 'Satın alma bölümü:' },
  'ИНН': { uz: 'INN', en: 'TIN', tr: 'Vergi No' },
  'Поставщиков нет.': { uz: 'Yetkazib beruvchilar yo‘q.', en: 'No suppliers.', tr: 'Tedarikçi yok.' },
  '+ Добавить поставщика': { uz: '+ Yetkazib beruvchi qo‘shish', en: '+ Add supplier', tr: ' + Tedarikçi ekle' },
  '-- Выберите материал --': { uz: '-- Mahsulotni tanlang --', en: '-- Select material --', tr: '-- Malzemeyi seçin --' },
  '-- Любой склад --': { uz: '-- Har qanday ombor --', en: '-- Any warehouse --', tr: '-- Herhangi bir depo --' },
  '(необяз.)': { uz: '(majburiy emas)', en: '(optional)', tr: '(isteğe bağlı)' },
  'мин:': { uz: 'min:', en: 'min:', tr: 'min:' },
  'резерв:': { uz: 'zaxira:', en: 'reserved:', tr: 'rezerv:' },
};

function translateDynamic(trimmed: string, lang: Exclude<Lang, 'ru'>): string | null {
  const pick = (uz: string, en: string, tr: string) => (lang === 'uz' ? uz : lang === 'tr' ? tr : en);
  // Keep the translated prefix when a component appends an API error or a
  // count. React often renders these as one text node, so exact literal
  // dictionary entries alone are not enough.
  const prefixes: Array<[RegExp, (suffix: string) => [string, string, string]]> = [
    [/^Не удалось загрузить дашборд:\s*(.*)$/, (s) => [`Dashboardni yuklab bo‘lmadi: ${s}`, `Could not load dashboard: ${s}`, `Gösterge paneli yüklenemedi: ${s}`]],
    [/^Ждут моего решения\s*·\s*(\d+)$/, (s) => [`Qarorimni kutmoqda · ${s}`, `Awaiting my decision · ${s}`, `Kararımı bekleyenler · ${s}`]],
    [/^Очередь снабжения\s*·\s*(\d+)$/, (s) => [`Ta’minot navbati · ${s}`, `Procurement queue · ${s}`, `Satın alma kuyruğu · ${s}`]],
    [/^Заявки по статусам\s*·\s*(\d+)$/, (s) => [`Holat bo‘yicha arizalar · ${s}`, `Requests by status · ${s}`, `Duruma göre talepler · ${s}`]],
  ];
  for (const [pattern, make] of prefixes) {
    const match = pattern.exec(trimmed);
    if (match) return pick(...make(match[1]));
  }
  let m = /^Вложения · (.+)$/.exec(trimmed);
  if (m) return pick(`Biriktirmalar · ${m[1]}`, `Attachments · ${m[1]}`, `Ekler · ${m[1]}`);
  m = /^Позиция (\d+)$/.exec(trimmed);
  if (m) return pick(`Pozitsiya ${m[1]}`, `Item ${m[1]}`, `Kalem ${m[1]}`);
  m = /^срок: (.+)$/.exec(trimmed);
  if (m) return pick(`muddat: ${m[1]}`, `term: ${m[1]}`, `süre: ${m[1]}`);
  m = /^Принято (.+) из (.+)$/.exec(trimmed);
  if (m) return pick(`Qabul qilindi ${m[1]} / ${m[2]}`, `Received ${m[1]} of ${m[2]}`, `Teslim alındı ${m[1]} / ${m[2]}`);
  m = /^из (.+)$/.exec(trimmed);
  if (m) return pick(`${m[1]} dan`, `of ${m[1]}`, `${m[1]} dan`);
  m = /^Сегодня · (.+)$/.exec(trimmed);
  if (m) return pick(`Bugun · ${m[1]}`, `Today · ${m[1]}`, `Bugün · ${m[1]}`);
  m = /^Вчера · (.+)$/.exec(trimmed);
  if (m) return pick(`Kecha · ${m[1]}`, `Yesterday · ${m[1]}`, `Dün · ${m[1]}`);
  m = /^(\d+) чел\.$/.exec(trimmed);
  if (m) return pick(`${m[1]} kishi`, `${m[1]} people`, `${m[1]} kişi`);
  m = /^(\d+) отд\.$/.exec(trimmed);
  if (m) return pick(`${m[1]} bo‘lim`, `${m[1]} departments`, `${m[1]} bölüm`);
  m = /^(\d+) непрочитанных$/.exec(trimmed);
  if (m) return pick(`${m[1]} ta o‘qilmagan`, `${m[1]} unread`, `${m[1]} okunmamış`);
  m = /^(.+) прав$/.exec(trimmed);
  if (m) return pick(`${m[1]} huquq`, `${m[1]} permissions`, `${m[1]} yetki`);
  m = /^(\d+) файл\(ов\) выбрано$/.exec(trimmed);
  if (m) return pick(`${m[1]} ta fayl tanlandi`, `${m[1]} files selected`, `${m[1]} dosya seçildi`);
  m = /^Файл (.+) больше 2 МБ$/.exec(trimmed);
  if (m) return pick(`${m[1]} uchun fayl hajmi 2 MB dan oshib ketdi`, `File ${m[1]} is bigger than 2 MB`, `${m[1]} dosyasının boyutu 2 MB’dan büyük`);
  m = /^(.+) больше 2 МБ$/.exec(trimmed);
  if (m) return pick(`${m[1]} uchun fayl hajmi 2 MB dan oshib ketdi`, `File ${m[1]} is bigger than 2 MB`, `${m[1]} dosyasının boyutu 2 MB’dan büyük`);
  m = /^Вложения: (.+)$/.exec(trimmed);
  if (m) return pick(`Biriktirmalar: ${m[1]}`, `Attachments: ${m[1]}`, `Ekler: ${m[1]}`);
  m = /^Вариант (.+)$/.exec(trimmed);
  if (m) return pick(`Variant ${m[1]}`, `Option ${m[1]}`, `Seçenek ${m[1]}`);
  m = /^Архивировать «(.+)»\?$/.exec(trimmed);
  if (m) return pick(`«${m[1]}»ni arxivlash`, `Archive «${m[1]}»`, `«${m[1]}» arşivle`);
  m = /^Удалить набор прав «(.+)»\?$/.exec(trimmed);
  if (m) return pick(`Huquqlar to‘plamini «${m[1]}»ni o‘chirish`, `Delete permission set «${m[1]}»`, `Yetki setini «${m[1]}» sil`);
  m = /^Удалить поле «(.+)»\?$/.exec(trimmed);
  if (m) return pick(`Maydon «${m[1]}»ni o‘chirish`, `Delete field «${m[1]}»`, `Alanı «${m[1]}» sil`);
  m = /^Удалить «(.+)»\?$/.exec(trimmed);
  if (m) return pick(`«${m[1]}»ni o‘chirish`, `Delete «${m[1]}»`, `«${m[1]}» sil`);
  m = /^Удалить заявку (.+)\? Она исчезнет у пользователей, но останется в базе данных\.$/.exec(trimmed);
  if (m) return pick(`Talabnoma ${m[1]}ni o‘chirish? Foydalanuvchilar uchun yo‘qoladi, ammo ma’lumotlar bazasida qoladi.`, `Delete request ${m[1]}? It will disappear for users, but remain in the database.`, `${m[1]} talebini sil? Kullanıcılarda kaybolur, ama veritabanında kalır.`);
  m = /^Удалить все заявки \((.+)\)\? Они исчезнут у пользователей, но останутся в базе данных\.$/.exec(trimmed);
  if (m) return pick(`(Barcha ${m[1]} arizani o‘chirish?) Foydalanuvchilardan yo‘qoladi, ammo bazada qoladi.`, `Delete all requests (${m[1]})? They will disappear for users, but remain in the database.`, `Tüm talepleri (${m[1]}) sil? Kullanıcılarda kaybolur, ancak veritabanında kalır.`);
  m = /^Удалить (.+)\? Если у пользователя есть история \(заявки, согласования\) — он будет архивирован\.$/.exec(trimmed);
  if (m) return pick(`Foydalanuvchi tarixida ma’lumot bo‘lsa (ariza, tasdiqlash), arxivlanadi: ${m[1]}`, `Delete ${m[1]}? If user has history (requests, approvals), they will be archived.`, `${m[1]} silinsin mi? Eğer kullanıcının geçmişi (talep, onay) varsa arşivlenecek.`);
  m = /^Материал: (.+)$/.exec(trimmed);
  if (m) return pick(`Material: ${m[1]}`, `Material: ${m[1]}`, `Malzeme: ${m[1]}`);
  m = /^Поставщик: (.+)$/.exec(trimmed);
  if (m) return pick(`Yetkazib beruvchi: ${m[1]}`, `Supplier: ${m[1]}`, `Tedarikçi: ${m[1]}`);
  m = /^Сотрудники: (.+)$/.exec(trimmed);
  if (m) return pick(`Xodimlar: ${m[1]}`, `Employees: ${m[1]}`, `Çalışanlar: ${m[1]}`);
  m = /^Поле: (.+)$/.exec(trimmed);
  if (m) return pick(`Maydon: ${m[1]}`, `Field: ${m[1]}`, `Alan: ${m[1]}`);
  m = /^Позиция (\d+): (.+)$/.exec(trimmed);
  if (m) return pick(`Pozitsiya ${m[1]}: ${m[2]}`, `Item ${m[1]}: ${m[2]}`, `Kalem ${m[1]}: ${m[2]}`);
  m = /^ID материала \((.+)\)$/.exec(trimmed);
  if (m) return pick(`Material ID (${m[1]})`, `Material ID (${m[1]})`, `Malzeme ID (${m[1]})`);
  m = /^ID склада \((.+)\)$/.exec(trimmed);
  if (m) return pick(`Ombor ID (${m[1]})`, `Warehouse ID (${m[1]})`, `Depo ID (${m[1]})`);
  m = /^Шаг (\d+)$/.exec(trimmed);
  if (m) return pick(`Bosqich ${m[1]}`, `Step ${m[1]}`, `Adım ${m[1]}`);
  m = /^жд[её]т (\d+) дн\.$/.exec(trimmed);
  if (m) return pick(`${m[1]} kun kutmoqda`, `${m[1]} days due`, `${m[1]} gün bekliyor`);
  m = /^жд[её]т (\d+)$/.exec(trimmed);
  if (m) return pick(`${m[1]} kun kutmoqda`, `${m[1]} day due`, `${m[1]} gün bekliyor`);
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

export function resolveInitialLang(stored: string | null, browserLanguage: string): Lang {
  // English was removed from the visible switcher. Keeping a legacy `en`
  // selection produced a misleading state: the UI stayed English while the
  // closed <select> displayed its first option, “Uzb”. Migrate unsupported
  // values to Russian, the existing product fallback, so label and content agree.
  if (stored === 'uz' || stored === 'ru' || stored === 'tr') return stored;
  const browser = browserLanguage.toLowerCase();
  if (browser.startsWith('uz')) return 'uz';
  if (browser.startsWith('tr')) return 'tr';
  return 'ru';
}

function initialLang(): Lang {
  return resolveInitialLang(localStorage.getItem(STORAGE_KEY), navigator.language);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang] = useState<Lang>(initialLang);
  const setLang = useCallback((next: Lang) => {
    if (next === lang) return;
    window.dispatchEvent(new CustomEvent(LANGUAGE_RELOAD_EVENT, { detail: { lang: next } }));
    localStorage.setItem(STORAGE_KEY, next);
    window.location.reload();
  }, [lang]);
  const tl = useCallback((text: string): string => {
    if (lang === 'ru') return text;
    const trimmed = text.trim();
    if (!trimmed) return text;
    // JSX often splits a paragraph across source lines, leaving newlines and
    // indentation in the text node. Dictionary entries are intentionally
    // written as normal sentences, so compare a whitespace-collapsed variant
    // as well; otherwise those perfectly valid translations never match.
    const normalized = trimmed.replace(/\s+/g, ' ');
    const translated = literalDict[trimmed]?.[lang]
      ?? literalDict[normalized]?.[lang]
      ?? translateDynamic(normalized, lang);
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
