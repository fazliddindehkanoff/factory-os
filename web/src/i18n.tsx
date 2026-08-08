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
};

function translateDynamic(trimmed: string, lang: Exclude<Lang, 'ru'>): string | null {
  const pick = (uz: string, en: string, tr: string) => (lang === 'uz' ? uz : lang === 'tr' ? tr : en);
  let m = /^Вложения · (.+)$/.exec(trimmed);
  if (m) return pick(`Biriktirmalar · ${m[1]}`, `Attachments · ${m[1]}`, `Ekler · ${m[1]}`);
  m = /^Позиция (\d+)$/.exec(trimmed);
  if (m) return pick(`Pozitsiya ${m[1]}`, `Item ${m[1]}`, `Kalem ${m[1]}`);
  m = /^срок: (.+)$/.exec(trimmed);
  if (m) return pick(`muddat: ${m[1]}`, `term: ${m[1]}`, `süre: ${m[1]}`);
  m = /^Принято (.+) из (.+)$/.exec(trimmed);
  if (m) return pick(`Qabul qilindi ${m[1]} / ${m[2]}`, `Received ${m[1]} of ${m[2]}`, `Teslim alındı ${m[1]} / ${m[2]}`);
  m = /^из (.+)$/.exec(trimmed);
  if (m) return pick(`${m[1]} dan`, `of ${m[1]}`, `/ ${m[1]}`);
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
