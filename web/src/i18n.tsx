import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

// FIXES 2026-07-17 (лист H): язык «Eng» заменён на «Türkçe» в переключателе.
// Код 'en' остаётся в типе для обратной совместимости (сохранённый выбор), но в
// выпадашке больше не предлагается.
export type Lang = 'ru' | 'uz' | 'en' | 'tr';

const STORAGE_KEY = 'factoryos.lang';

export const LANG_LABELS: Record<Lang, string> = {
  ru: 'Рус',
  uz: 'Uzb',
  en: 'Eng',
  tr: 'Turk',
};

/** Языки, доступные в переключателе (лист H): Uzb / Рус / Türkçe. */
export const SWITCHER_LANGS: Lang[] = ['uz', 'ru', 'tr'];

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
  'Очередь снабжения': { uz: 'Ta’minot navbati', en: 'Procurement queue', tr: 'Satın alma kuyruğu' },
  'Активных всего': { uz: 'Jami aktiv', en: 'Total active', tr: 'Toplam aktif' },
  'Созданные мной': { uz: 'Men yaratganlar', en: 'Created by me', tr: 'Oluşturduklarım' },
  'Последние события': { uz: 'Oxirgi voqealar', en: 'Recent events', tr: 'Son olaylar' },
  'Ждут моего решения': { uz: 'Qarorimni kutmoqda', en: 'Awaiting my decision', tr: 'Kararımı bekleyenler' },
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
  'Материал принят на склад': { uz: 'Material omborga qabul qilindi', en: 'Material received to warehouse', tr: 'Malzeme depoya alındı' },
  'Материал выдан со склада': { uz: 'Material ombordan berildi', en: 'Material issued from warehouse', tr: 'Malzeme depodan çıkarıldı' },
  'Выберите материал': { uz: 'Materialni tanlang', en: 'Choose material', tr: 'Malzeme seçin' },
  'Любой склад': { uz: 'Istalgan ombor', en: 'Any warehouse', tr: 'Herhangi bir depo' },
  'ID материала (каталог пуст)': { uz: 'Material ID (katalog bo‘sh)', en: 'Material ID (catalog is empty)', tr: 'Malzeme ID (katalog boş)' },
  'ID склада (необязательно)': { uz: 'Ombor ID (ixtiyoriy)', en: 'Warehouse ID (optional)', tr: 'Depo ID (isteğe bağlı)' },
  '(необяз.)': { uz: '(ixtiyoriy)', en: '(optional)', tr: '(isteğe bağlı)' },
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
  'Складской обзор': { uz: 'Ombor ko‘rinishi', en: 'Warehouse overview', tr: 'Depo özeti' },
  'Открыть склад': { uz: 'Omborni ochish', en: 'Open warehouse', tr: 'Depoyu aç' },
  'Позиции ниже минимума': { uz: 'Minimumdan past pozitsiyalar', en: 'Items below minimum', tr: 'Minimum altındaki kalemler' },
  'Все остатки в норме': { uz: 'Barcha qoldiqlar me’yorda', en: 'All balances are normal', tr: 'Tüm stoklar normal' },
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
  'все →': { uz: 'barchasi →', en: 'all →', tr: 'tümü →' },
  'Не удалось загрузить:': { uz: 'Yuklab bo‘lmadi:', en: 'Could not load:', tr: 'Yüklenemedi:' },
  'Нет заявок, ожидающих вашего решения.': { uz: 'Qaroringizni kutayotgan arizalar yo‘q.', en: 'No requests are awaiting your decision.', tr: 'Kararınızı bekleyen talep yok.' },
  'Нет заявок в закупке.': { uz: 'Xariddagi arizalar yo‘q.', en: 'No requests in procurement.', tr: 'Satın almada talep yok.' },
  'Пока нет событий — здесь появятся обновления по вашим заявкам.': { uz: 'Hozircha voqealar yo‘q — arizalaringiz bo‘yicha yangiliklar shu yerda chiqadi.', en: 'No events yet. Updates for your requests will appear here.', tr: 'Henüz olay yok. Taleplerinizin güncellemeleri burada görünecek.' },
  'Не удалось загрузить дашборд:': { uz: 'Dashboard yuklanmadi:', en: 'Could not load dashboard:', tr: 'Dashboard yüklenemedi:' },
  'Показать ещё': { uz: 'Yana ko‘rsatish', en: 'Show more', tr: 'Daha fazla göster' },
  'Загрузка...': { uz: 'Yuklanmoqda...', en: 'Loading...', tr: 'Yükleniyor...' },
  'Экспорт в Excel (CSV)': { uz: 'Excelga eksport (CSV)', en: 'Export to Excel (CSV)', tr: 'Excel’e aktar (CSV)' },
  'Не удалось выгрузить CSV': { uz: 'CSV eksport qilib bo‘lmadi', en: 'Could not export CSV', tr: 'CSV dışa aktarılamadı' },
  'Телефон': { uz: 'Telefon', en: 'Phone', tr: 'Telefon' },
  'Ваше имя': { uz: 'Ismingiz', en: 'Your name', tr: 'Adınız' },
  'Должность': { uz: 'Lavozim', en: 'Position', tr: 'Pozisyon' },
  'напр. Инженер': { uz: 'masalan, muhandis', en: 'e.g. Engineer', tr: 'örn. Mühendis' },
  'PIN для подписи': { uz: 'Imzo uchun PIN', en: 'PIN for signing', tr: 'İmza PIN’i' },
  '4–8 цифр. Нужен для согласования и других действий с подписью.': { uz: '4–8 raqam. Tasdiqlash va imzo talab qiladigan amallar uchun kerak.', en: '4-8 digits. Required for approvals and signed actions.', tr: '4-8 rakam. Onaylar ve imzalı işlemler için gerekir.' },
  'PIN сохранён ✓': { uz: 'PIN saqlandi ✓', en: 'PIN saved ✓', tr: 'PIN kaydedildi ✓' },
  'Администратор': { uz: 'Administrator', en: 'Administrator', tr: 'Yönetici' },
  'Учредитель': { uz: 'Ta’sischi', en: 'Founder', tr: 'Kurucu' },
  'Согласующий': { uz: 'Tasdiqlovchi', en: 'Approver', tr: 'Onaylayan' },
  'Сотрудник': { uz: 'Xodim', en: 'Employee', tr: 'Çalışan' },
  'У вас нет прав на согласование': { uz: 'Tasdiqlash huquqingiz yo‘q', en: 'You do not have approval permissions', tr: 'Onay yetkiniz yok' },
  'Обратитесь к администратору для получения необходимых прав.': { uz: 'Kerakli huquqlar uchun administratorga murojaat qiling.', en: 'Contact an administrator to get the required permissions.', tr: 'Gerekli yetkiler için yöneticinizle iletişime geçin.' },
  'Входящих нет': { uz: 'Kirish qutisi bo‘sh', en: 'No inbox items', tr: 'Gelen kutusu boş' },
  'Сейчас нет заявок, требующих вашего действия.': { uz: 'Hozir sizdan amal kutayotgan arizalar yo‘q.', en: 'No requests need your action right now.', tr: 'Şu anda işlem bekleyen talep yok.' },
  'Низкая': { uz: 'Past', en: 'Low', tr: 'Düşük' },
  'Стандартная': { uz: 'Standart', en: 'Normal', tr: 'Standart' },
  'Срочная': { uz: 'Shoshilinch', en: 'Urgent', tr: 'Acil' },
  'Аварийная': { uz: 'Avariya', en: 'Emergency', tr: 'Acil durum' },
  'Критичная': { uz: 'Kritik', en: 'Critical', tr: 'Kritik' },
  'сегодня': { uz: 'bugun', en: 'today', tr: 'bugün' },
  'ждёт 1 день': { uz: '1 kun kutmoqda', en: 'waiting 1 day', tr: '1 gündür bekliyor' },
  'создана': { uz: 'yaratildi', en: 'created', tr: 'oluşturuldu' },
  'Очередь': { uz: 'Navbat', en: 'Queue', tr: 'Kuyruk' },
  'Заявок в закупке нет.': { uz: 'Xaridda arizalar yo‘q.', en: 'No requests in purchasing.', tr: 'Satın almada talep yok.' },
  '+ Добавить поставщика': { uz: '+ Yetkazib beruvchi qo‘shish', en: '+ Add supplier', tr: '+ Tedarikçi ekle' },
  'Поставщиков нет.': { uz: 'Yetkazib beruvchilar yo‘q.', en: 'No suppliers.', tr: 'Tedarikçi yok.' },
  'ИНН': { uz: 'STIR', en: 'TIN', tr: 'Vergi no' },
  'Архив': { uz: 'Arxiv', en: 'Archive', tr: 'Arşiv' },
  'Новый поставщик': { uz: 'Yangi yetkazib beruvchi', en: 'New supplier', tr: 'Yeni tedarikçi' },
  'напр. ООО Поставка': { uz: 'masalan, Pоставка MChJ', en: 'e.g. Supply LLC', tr: 'örn. Tedarik Ltd.' },
  'необязательно': { uz: 'ixtiyoriy', en: 'optional', tr: 'isteğe bağlı' },
  'Сессия истекла — войдите снова': { uz: 'Sessiya tugadi — qayta kiring', en: 'Session expired. Sign in again.', tr: 'Oturum süresi doldu — tekrar giriş yapın' },
  'Сервер не ответил вовремя — возможно, база просыпается. Повторите через пару секунд.': { uz: 'Server vaqtida javob bermadi — baza uyg‘onayotgan bo‘lishi mumkin. Bir necha soniyadan keyin qayta urinib ko‘ring.', en: 'The server did not respond in time. The database may be waking up. Try again in a few seconds.', tr: 'Sunucu zamanında yanıt vermedi. Veritabanı uyanıyor olabilir. Birkaç saniye sonra tekrar deneyin.' },
  'Нет связи с сервером. Проверьте подключение.': { uz: 'Server bilan aloqa yo‘q. Ulanishni tekshiring.', en: 'No connection to the server. Check your connection.', tr: 'Sunucuyla bağlantı yok. Bağlantınızı kontrol edin.' },
  'Ожидает согласования': { uz: 'Tasdiq kutmoqda', en: 'Waiting for approval', tr: 'Onay bekliyor' },
  'Склад должен проверить наличие': { uz: 'Ombor mavjudlikni tekshirishi kerak', en: 'Warehouse must check availability', tr: 'Depo stok durumunu kontrol etmeli' },
  'Снабжение подбирает поставщика': { uz: 'Ta’minot yetkazib beruvchini tanlamoqda', en: 'Procurement is selecting a supplier', tr: 'Satın alma tedarikçi seçiyor' },
  'Ожидает доставки': { uz: 'Yetkazishni kutmoqda', en: 'Waiting for delivery', tr: 'Teslimat bekleniyor' },
  'Склад принимает товар': { uz: 'Ombor mahsulotni qabul qilmoqda', en: 'Warehouse is receiving goods', tr: 'Depo ürünü teslim alıyor' },
  'Склад должен выдать материал': { uz: 'Ombor materialni berishi kerak', en: 'Warehouse must issue material', tr: 'Depo malzemeyi çıkarmalı' },
  'Ожидает подтверждения получения': { uz: 'Qabul tasdig‘ini kutmoqda', en: 'Waiting for receipt confirmation', tr: 'Teslim alma onayı bekleniyor' },
  'Ожидает действия': { uz: 'Amal kutmoqda', en: 'Waiting for action', tr: 'İşlem bekliyor' },
  'Склады ещё не настроены. Добавьте их в админке → «Структура».': { uz: 'Omborlar hali sozlanmagan. Ularni admin bo‘limida → “Tuzilma” orqali qo‘shing.', en: 'Warehouses are not configured yet. Add them in Admin → Structure.', tr: 'Depolar henüz yapılandırılmamış. Admin → Yapı bölümünden ekleyin.' },
  '— выберите —': { uz: '— tanlang —', en: '— choose —', tr: '— seçin —' },
  'Да': { uz: 'Ha', en: 'Yes', tr: 'Evet' },
  'нет': { uz: 'yo‘q', en: 'none', tr: 'yok' },
  'Укажите количество больше нуля для каждого продукта': { uz: 'Har bir mahsulot uchun noldan katta miqdor kiriting', en: 'Enter a quantity greater than zero for each product', tr: 'Her ürün için sıfırdan büyük miktar girin' },
  'Укажите причину': { uz: 'Sababni kiriting', en: 'Enter a reason', tr: 'Nedeni belirtin' },
  'Пуш в Telegram не дошёл — уведомление доступно здесь': { uz: 'Telegram push yetib bormadi — bildirishnoma shu yerda mavjud', en: 'Telegram push did not arrive. The notification is available here.', tr: 'Telegram bildirimi ulaşmadı — bildirim burada mevcut' },
  'К заявке': { uz: 'Arizaga', en: 'To request', tr: 'Talebe git' },
  'Прочитать все': { uz: 'Hammasini o‘qilgan qilish', en: 'Mark all read', tr: 'Tümünü okundu yap' },
  'Уведомлений пока нет.': { uz: 'Hozircha bildirishnomalar yo‘q.', en: 'No notifications yet.', tr: 'Henüz bildirim yok.' },
  'Ждёт вас': { uz: 'Sizni kutmoqda', en: 'Waiting for you', tr: 'Sizi bekliyor' },
  'Этап пройден': { uz: 'Bosqich o‘tildi', en: 'Step passed', tr: 'Aşama geçildi' },
  'Возврат на этап': { uz: 'Bosqichga qaytarildi', en: 'Returned to step', tr: 'Aşamaya geri döndü' },
  'Безопасность': { uz: 'Xavfsizlik', en: 'Security', tr: 'Güvenlik' },
  'Просрочено': { uz: 'Muddati o‘tgan', en: 'Overdue', tr: 'Gecikmiş' },
  'Сводка': { uz: 'Xulosa', en: 'Summary', tr: 'Özet' },
  'Новое': { uz: 'Yangi', en: 'New', tr: 'Yeni' },
  'Прочитано': { uz: 'O‘qilgan', en: 'Read', tr: 'Okundu' },
  'Отправляется': { uz: 'Yuborilmoqda', en: 'Sending', tr: 'Gönderiliyor' },
  'Ваш Telegram ID': { uz: 'Telegram ID’ingiz', en: 'Your Telegram ID', tr: 'Telegram ID’niz' },
  'Вход...': { uz: 'Kirilmoqda...', en: 'Signing in...', tr: 'Giriş yapılıyor...' },
  'Войти (dev)': { uz: 'Kirish (dev)', en: 'Sign in (dev)', tr: 'Giriş yap (dev)' },
  'Откройте внутри Telegram для обычного входа. Локально — dev-вход по Telegram ID.': { uz: 'Oddiy kirish uchun Telegram ichida oching. Lokal muhitda Telegram ID orqali dev-kirish ishlaydi.', en: 'Open inside Telegram for normal sign-in. Locally, use dev sign-in by Telegram ID.', tr: 'Normal giriş için Telegram içinde açın. Yerelde Telegram ID ile dev girişi kullanın.' },
  'Тестовые пользователи': { uz: 'Test foydalanuvchilar', en: 'Test users', tr: 'Test kullanıcıları' },
  'резерв': { uz: 'rezerv', en: 'reserved', tr: 'rezerve' },
  'мин': { uz: 'min', en: 'min', tr: 'min' },
  'Вы не привязаны к организации. Попросите администратора назначить вам права.': { uz: 'Siz tashkilotga biriktirilmagansiz. Administratordan huquq berishini so‘rang.', en: 'You are not linked to an organization. Ask an administrator to assign permissions.', tr: 'Bir kuruluşa bağlı değilsiniz. Yöneticiden yetki atamasını isteyin.' },
  'Override — решение мимо оставшихся шагов': { uz: 'Override — qolgan bosqichlarsiz qaror', en: 'Override — decide without remaining steps', tr: 'Override — kalan adımları atlayarak karar' },
  'Причина (обязательно)': { uz: 'Sabab (majburiy)', en: 'Reason (required)', tr: 'Neden (zorunlu)' },
  'Разрешить': { uz: 'Ruxsat berish', en: 'Approve override', tr: 'İzin ver' },
  'История действий (аудит)': { uz: 'Amallar tarixi (audit)', en: 'Action history (audit)', tr: 'İşlem geçmişi (denetim)' },
  'Аудит-лог': { uz: 'Audit log', en: 'Audit log', tr: 'Denetim kaydı' },
  'система': { uz: 'tizim', en: 'system', tr: 'sistem' },
  'Ожидаемая дата получения': { uz: 'Kutilayotgan qabul sanasi', en: 'Expected receipt date', tr: 'Beklenen teslim alma tarihi' },
  'Наименование': { uz: 'Nomi', en: 'Item name', tr: 'Ad' },
  'Продукты': { uz: 'Mahsulotlar', en: 'Products', tr: 'Ürünler' },
  'Ед. изм.': { uz: 'O‘lch. birl.', en: 'Unit', tr: 'Birim' },
  'Название продукта': { uz: 'Mahsulot nomi', en: 'Product name', tr: 'Ürün adı' },
  'шт, кг...': { uz: 'dona, kg...', en: 'pcs, kg...', tr: 'adet, kg...' },
  'Назначение, склад, срочность, примечания...': { uz: 'Maqsad, ombor, shoshilinchlik, izohlar...', en: 'Purpose, warehouse, urgency, notes...', tr: 'Amaç, depo, aciliyet, notlar...' },
  'Добавьте хотя бы один продукт': { uz: 'Kamida bitta mahsulot qo‘shing', en: 'Add at least one product', tr: 'En az bir ürün ekleyin' },
  '— не выбран —': { uz: '— tanlanmagan —', en: '— not selected —', tr: '— seçilmedi —' },
  '— не выбрано —': { uz: '— tanlanmagan —', en: '— not selected —', tr: '— seçilmedi —' },
  'Сумма КП (UZS)': { uz: 'Taklif summasi (UZS)', en: 'Offer amount (UZS)', tr: 'Teklif tutarı (UZS)' },
  'По позициям': { uz: 'Pozitsiyalar bo‘yicha', en: 'By item', tr: 'Kalem bazında' },
  'Не указан': { uz: 'Ko‘rsatilmagan', en: 'Not specified', tr: 'Belirtilmedi' },
  'Перечисление': { uz: 'Bank o‘tkazmasi', en: 'Bank transfer', tr: 'Havale' },
  'Наличные': { uz: 'Naqd', en: 'Cash', tr: 'Nakit' },
  'Передать снабженцу': { uz: 'Ta’minotchiga berish', en: 'Assign to procurement user', tr: 'Satın alma uzmanına aktar' },
  'Принять в работу': { uz: 'Ishga qabul qilish', en: 'Accept to work', tr: 'İşe al' },
  'На доработке': { uz: 'Qayta ishlashda', en: 'In revision', tr: 'Düzeltmede' },
  'НДС': { uz: 'NDS', en: 'VAT', tr: 'KDV' },
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
  m = /^(.+) прав$/.exec(trimmed);
  if (m) return pick(`${m[1]} huquq`, `${m[1]} permissions`, `${m[1]} yetki`);
  m = /^ждёт (\d+) дн\.$/.exec(trimmed);
  if (m) return pick(`${m[1]} kun kutmoqda`, `waiting ${m[1]} days`, `${m[1]} gündür bekliyor`);
  m = /^позиций: (\d+)$/.exec(trimmed);
  if (m) return pick(`pozitsiyalar: ${m[1]}`, `items: ${m[1]}`, `kalem: ${m[1]}`);
  m = /^Поставщик: (.+)$/.exec(trimmed);
  if (m) return pick(`Yetkazib beruvchi: ${m[1]}`, `Supplier: ${m[1]}`, `Tedarikçi: ${m[1]}`);
  m = /^Архивировать «(.+)»\?$/.exec(trimmed);
  if (m) return pick(`“${m[1]}” arxivlansinmi?`, `Archive “${m[1]}”?`, `“${m[1]}” arşivlensin mi?`);
  m = /^Не удалось загрузить уведомления: (.+)$/.exec(trimmed);
  if (m) return pick(`Bildirishnomalar yuklanmadi: ${m[1]}`, `Could not load notifications: ${m[1]}`, `Bildirimler yüklenemedi: ${m[1]}`);
  m = /^(\d+) непрочитанных$/.exec(trimmed);
  if (m) return pick(`${m[1]} ta o‘qilmagan`, `${m[1]} unread`, `${m[1]} okunmamış`);
  m = /^прочитано (.+)$/.exec(trimmed);
  if (m) return pick(`o‘qilgan ${m[1]}`, `read ${m[1]}`, `okundu ${m[1]}`);
  m = /^(.+) файл\(ов\)$/.exec(trimmed);
  if (m) return pick(`${m[1]} fayl`, `${m[1]} files`, `${m[1]} dosya`);
  m = /^(.+) файл\(ов\) выбрано$/.exec(trimmed);
  if (m) return pick(`${m[1]} fayl tanlandi`, `${m[1]} files selected`, `${m[1]} dosya seçildi`);
  m = /^Файл (.+) больше 2 МБ$/.exec(trimmed);
  if (m) return pick(`${m[1]} fayli 2 MB dan katta`, `File ${m[1]} is larger than 2 MB`, `${m[1]} dosyası 2 MB'den büyük`);
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
  if (stored === 'uz' || stored === 'ru' || stored === 'en' || stored === 'tr') return stored;
  const browser = navigator.language.toLowerCase();
  if (browser.startsWith('uz')) return 'uz';
  if (browser.startsWith('tr')) return 'tr';
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
