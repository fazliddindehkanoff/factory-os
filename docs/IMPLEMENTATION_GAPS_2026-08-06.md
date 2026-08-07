# Role implementation audit — 2026-08-06

Проверено на test Web App (`:3100`) по всем 18 seeded system-role accounts и
семишаговому workflow. Live QA создал заявку с двумя позициями, добавил два КП,
вернул заявку на повторный поиск, выбрал второе КП и провёл её до `approved`.

## Реализовано и подтверждено

- `requester` / `warehouse_worker`: вход, собственные заявки, создание и
  отслеживание.
- `warehouse`: шаг 1, назначение снабженца, reject/revision controls.
- `procurement_manager`: добавление КП по каждой позиции и финальная доставка.
- `procurement_head`: просмотр нескольких КП, возврат на повторный поиск, выбор
  поставщика и отправка предложения дальше.
- `deputy_director`, `director`, `owner`: только свой approval step, PIN и reject.
- `admin`: видит данные/настройки, но не получает business workflow actions.
- Все остальные роли успешно аутентифицируются; read-only/oversight права
  проверены permission matrix тестами.

## Qolgan implementation gaps

1. **Finance head / finance manager** — `mark_paid` с PIN работает на карточке,
   но нет отдельной payment queue, invoice registry и bank-payment workspace.
2. **Accountant** — только read-only finance visibility; нет загрузки/проверки
   счёта и платёжного поручения.
3. **Department head** — scope пока holding-wide; реальное ограничение по
   department ещё не реализовано.
4. **Warehouse manager** — receive/issue UI есть, но отдельная stock adjustment
   операция с обязательным PIN отсутствует (permission `warehouse.adjust` уже есть).
5. **Auditor / reports users** — audit timeline и CSV export есть, но отдельного
   analytics/report builder экрана нет.
6. **Observer** — read-only и own-scope корректны; если observer ничего yaratmagan
   bo‘lsa, uning request list’i tabiiy ravishda bo‘sh bo‘ladi.

## Shu auditda tuzatilgan improvementlar

- Test workflow 9 bosqichdan 7 bosqichga qisqartirildi; receiving va close olib
  tashlandi, final status `approved`.
- Price review 2-bosqichga qayta oladi, shuning uchun bir nechta raqobatchi КП
  yig‘ish ishlaydi.
- Final delivery step responsible role `procurement_manager` bilan moslashtirildi.
- Dev role switcher full matrix login’larini rate-limit qilmaydi; production va
  real auth endpointlarining 10/min himoyasi o‘zgarmagan.
- Role’siz orphan dev accounts role switcher’dan chiqarildi.
- Yashirin legacy English holati sabab “Uzb” label + English content nomuvofiqligi
  tuzatildi; Uzbek empty states, role, department va unread labels to‘ldirildi.
- Test subdomain uchun TLS tekshiruvi barqarorlashtirildi: asosiy sertifikatga
  `test.138-249-7-204.sslip.io` SAN qo‘shildi va avtomatik renewal saqlandi.
