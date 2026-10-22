# Hardening Review — Đề 32 Chat

**Ngày kiểm tra:** 22/10/2026
**Trạng thái:** READY FOR REVIEW — role runtime và pgAdmin đã được bổ sung, kiểm thử; bootstrap role và dữ liệu hiện có được giữ nguyên.

## 1. Mục tiêu

Kiểm tra hardening cơ bản cho hệ thống Chat gồm Node.js/Socket.IO, PostgreSQL,
Nginx, Prometheus, Grafana, Loki và Promtail; xác nhận các kiểm soát hiện có,
chạy kiểm thử và ghi nhận rủi ro. Bổ sung role runtime least-privilege và
pgAdmin loopback sau khi xác minh thử migration/owner transfer trong transaction
rollback. Không thay đổi nội dung hàng dữ liệu, bootstrap role hoặc volumes.

## 2. Các biện pháp được kiểm tra

- Nginx reverse proxy, WebSocket upgrade, security headers, CSP, `server_tokens`
  và các endpoint metrics/status.
- Cổng host thực tế, mạng Docker, restart policy, volumes, quyền tiến trình,
  mount chỉ đọc và quyền Docker socket.
- Quyền PostgreSQL của tài khoản ứng dụng và exporter; việc database có publish
  cổng ra host hay không.
- Xác thực/session, phân quyền phòng, Socket.IO, kiểm tra đầu vào và giới hạn
  payload.
- Git ignore, Docker build context và kết quả `git ls-files` cho `.env`,
  `.secrets/`, `node_modules/`.
- Quyền truy cập Grafana/Prometheus và khả năng rò rỉ dữ liệu qua log.

Không có mật khẩu, token, cookie, session secret hoặc nội dung file secret nào
được đưa vào báo cáo.

## 3. Kết quả kiểm tra

### Nginx và HTTP

- `docker compose exec -T nginx nginx -t`: PASS.
- HTTP qua `http://localhost:8080/` và `/health`: 200.
- Header thực tế: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: same-origin`, CSP có mặt, `Cache-Control: no-store`;
  `X-Powered-By` không có. CSP giới hạn script/style inline bằng hash và không
  dùng `unsafe-inline`/`unsafe-eval` (cũng được xác nhận bởi `npm test`).
- `server_tokens off` được cấu hình trên cả listener công khai và listener
  status nội bộ; response công khai chỉ nhận diện Nginx, không lộ phiên bản.
- WebSocket proxy có HTTP/1.1, `Upgrade`, `Connection`, buffering off và timeout
  dài; bộ test Chat xác nhận WebSocket cùng polling hoạt động qua Nginx.
- `/metrics` và `/stub_status` qua cổng công khai đều trả 404.

### Docker và network

- `docker compose config --quiet`: PASS. Các container hiện có ở trạng thái
  running; PostgreSQL healthy.
- Bindings thực tế: Nginx `0.0.0.0:8080`; Prometheus
  `127.0.0.1:9090`; Grafana `127.0.0.1:3001`. App chỉ expose cổng 3000 bên
  trong Docker; PostgreSQL, exporters, cAdvisor, Loki và Promtail không publish
  cổng host.
- Backend, monitoring và logging networks được đánh dấu internal. PostgreSQL
  volume và volume của monitoring/logging là named volumes, được giữ nguyên.
- Các service chính dùng `unless-stopped`; `postgres-metrics-init` dùng policy
  `no` như tác vụ khởi tạo chạy một lần.
- App chạy bằng UID 1000 (`node`); PostgreSQL server chạy bằng UID 999; worker
  Nginx chạy bằng user không phải root, dù master chạy root; Prometheus,
  Grafana, exporter PostgreSQL và Loki chạy bằng user không phải root.
- **WARNING:** cAdvisor chạy privileged/root, mount host root, Docker socket,
  containerd và các đường dẫn host. Promtail chạy root và mount Docker socket.
  Socket mount là read-only nhưng điều đó không giới hạn đầy đủ quyền API của
  Docker socket. Các quyền này phục vụ thu thập metrics/log trong cấu hình hiện
  tại nhưng làm tăng rủi ro nếu container tương ứng bị xâm nhập.
- **WARNING:** Nginx là service duy nhất bind `0.0.0.0:8080`, do đó có thể truy
  cập từ mạng mà máy host cho phép; không có HTTPS. Security headers không mã
  hóa lưu lượng và cookie hiện không bật `Secure`. Phù hợp chạy demo HTTP nội
  bộ, không nên coi là cấu hình triển khai công khai.

### PostgreSQL

- PostgreSQL không publish cổng ra host và chỉ nối qua Docker backend network.
- Role `chat_metrics`: không superuser, không có quyền tạo database/role hoặc
  replication; được cấp `pg_monitor`. Monitoring test xác nhận exporter không
  đọc bảng người dùng.
- Role `chat_runtime`: login được, không superuser, không createdb/createrole,
  không replication và không bypass RLS. Có CONNECT, USAGE/CREATE trên schema
  `public`, sở hữu các bảng chat/session và sequence cần cho migration lặp.
- Role bootstrap `chatuser` được giữ nguyên; chỉ one-shot provisioning và tác vụ
  metrics init vẫn dùng role này. Ứng dụng đọc mật khẩu runtime từ Docker secret
  thay vì dùng credential bootstrap.
- `pgadmin` dùng secret file cho mật khẩu web, volume riêng để giữ trạng thái,
  kết nối qua internal backend network và chỉ bind `127.0.0.1:5050`.
- Owner transfer và migration `init.sql` đã được thử trên các bảng hiện có
  trong transaction rollback trước khi triển khai. Số lượng hàng của users,
  messages, rooms, room_members và session trước/sau triển khai được giữ nguyên.
- Đăng nhập pgAdmin và đăng ký server PostgreSQL bằng `chat_runtime` đã được
  kiểm tra; xem được database `chatdb` và các bảng ứng dụng.

### Node.js và Socket.IO

- Bộ test xác nhận đăng ký/đăng nhập, session rotation, chặn socket chưa xác
  thực, kiểm tra quyền thành viên/phòng, chặn gửi tin ngoài phòng, lịch sử,
  logout ngắt socket và session hết hạn không thể gửi tin.
- Có validate username/password, giới hạn nội dung tin nhắn 2.000 ký tự và tên
  phòng 100 ký tự. `express.json()` dùng giới hạn mặc định của Express; request
  JSON 120 KB thực tế bị từ chối với HTTP 413. Nginx giới hạn body ở 2 MB.
- Session secret phải có ít nhất 32 ký tự; cookie bật `HttpOnly`, `SameSite=Lax`
  và thời hạn 24 giờ.
- **WARNING:** cookie đặt `secure: false`, cần thiết cho HTTP local hiện tại.
  Nếu triển khai qua HTTPS, cần bật `Secure` và cấu hình proxy HTTPS tương ứng.
- Không thấy lỗi chức năng hoặc lỗi xác thực trong các test đã chạy.

### Secrets, monitoring và logging

- `.gitignore` bỏ qua `.env`, `.secrets/`, `node_modules/`; `.dockerignore` cũng
  loại trừ các đường dẫn nhạy cảm/không cần cho image.
- `git ls-files -- .env .secrets node_modules` không trả file nào; `git
  check-ignore` xác nhận các đường dẫn này được ignore. Không in nội dung
  secrets.
- Grafana API yêu cầu xác thực (API dashboard trả 401 khi không có credentials);
  anonymous access bị tắt. Grafana chỉ bind loopback.
- Prometheus chỉ bind loopback, nhưng endpoint readiness/API truy cập được từ
  host mà không cần xác thực. Người dùng khác có quyền truy cập máy local có
  thể đọc metrics trong khi service đang chạy.
- Monitoring xác nhận 5/5 Prometheus targets UP, datasource Grafana hoạt động,
  12/12 panel trả dữ liệu số.
- Logging test xác nhận Loki sẵn sàng, Promtail 2/2 targets, truy vấn LogQL có
  kết quả, log còn sau restart và các canary password/token/cookie/path/room/
  message không xuất hiện trong log trả về.
- **WARNING:** Promtail đã EOL; được giữ theo yêu cầu môn học. Docker socket
  được dùng cho service discovery/thu thập logs. Đây là rủi ro bảo trì và quyền
  host, không phải lỗi chặn chức năng hiện tại.

## 4. Bảng trạng thái

| Hạng mục | Trạng thái | Bằng chứng / ghi chú |
|---|---|---|
| Nginx reverse proxy và WebSocket | PASS | `nginx -t`; npm test qua Nginx |
| Security headers, CSP, server token | PASS | HTTP response và kiểm tra CSP trong npm test |
| Metrics/status không public qua Nginx | PASS | `/metrics`, `/stub_status` trả 404 |
| Port bindings và Docker networks | PASS | Chỉ Nginx public; admin loopback; exporter/database/logging không publish |
| Restart policies và persistence | PASS | Compose inspection; volumes giữ nguyên |
| PostgreSQL không publish host port | PASS | Runtime bindings và internal backend |
| Exporter PostgreSQL least privilege | PASS | Monitoring test và role attributes |
| Role PostgreSQL runtime least privilege | PASS | `chat_runtime` không superuser; migration và DML qua app chạy được |
| Xác thực, session, phân quyền phòng và logout | PASS | `npm test`, `npm run test:docker` |
| Input/body size validation | PASS | 120 KB JSON trả 413; validation trong npm test |
| `.env`, `.secrets/`, `node_modules/` không tracked | PASS | `git ls-files`, `git check-ignore` |
| Grafana authorization | PASS | API không xác thực trả 401; bind loopback |
| Prometheus authorization | WARNING | Chỉ loopback nhưng API nội bộ host không yêu cầu auth |
| Log không chứa dữ liệu canary nhạy cảm | PASS | `npm run test:logging` |
| cAdvisor/Promtail socket và quyền host | WARNING | cAdvisor privileged/root; cả hai mount Docker socket |
| Promtail được hỗ trợ upstream | WARNING | Promtail EOL; dùng theo yêu cầu khóa học |
| pgAdmin | PASS | Login thành công, kết nối chatdb bằng runtime role, xem được bảng |
| HTTPS/cookie Secure | WARNING | Chưa cấu hình; chấp nhận cho demo HTTP local |
| Giao diện browser thật | NOT TESTED trong lượt này | Người dùng cho biết đã kiểm thử thành công; lượt này chỉ xác nhận HTTP/API và test tự động |

## 5. Lỗi và rủi ro còn lại

| Mức độ / trạng thái | File liên quan | Nguyên nhân | Cách sửa đơn giản nhất | Ảnh hưởng chức năng |
|---|---|---|---|---|
| MEDIUM / WARNING | `compose.yaml` | cAdvisor privileged/root và Docker socket; Promtail root và Docker socket. Mount socket read-only không đồng nghĩa API socket chỉ đọc. | Chỉ bật profile monitoring khi cần; giới hạn host/container được mount hoặc bỏ cAdvisor nếu chấp nhận mất metrics container. Với logging, cân nhắc collector thay Docker socket ở lần nâng cấp riêng. | Bỏ cAdvisor làm mất metrics container; bỏ Promtail/socket làm gián đoạn thu thập log. |
| LOW / WARNING | `compose.yaml` | Prometheus không có auth, dù chỉ bind loopback. | Giữ máy host tin cậy hoặc chặn port loopback bằng firewall; chỉ thêm auth nếu cần truy cập từ máy khác. | Hạn chế truy cập local có thể ảnh hưởng công cụ dashboard/kiểm thử nếu cấu hình sai. |
| LOW / WARNING | `server.js`, `compose.yaml` | HTTP hiện tại dùng cookie `secure: false`; không mã hóa dữ liệu trên mạng. | Chỉ khi triển khai HTTPS: bật cookie Secure và cấu hình proxy/TLS đúng cách. | Bật Secure khi vẫn chạy HTTP sẽ làm browser không gửi cookie, gây lỗi đăng nhập. |
| Bảo trì / WARNING | `compose.yaml`, `promtail/config.yml` | Promtail đã EOL. | Giữ nguyên cho yêu cầu môn học; lập kế hoạch chuyển công cụ ở một thay đổi riêng nếu tiếp tục vận hành lâu dài. | Không ảnh hưởng test hiện tại; chuyển collector có thể ảnh hưởng logging. |

Role bootstrap PostgreSQL vẫn là superuser theo thiết kế image/volume hiện có.
Ứng dụng không sử dụng role này nữa; biến `DB_PASSWORD` vẫn được truyền tới
container/tác vụ khởi tạo tin cậy để provisioning và cấp `pg_monitor`.

## 6. Kết quả kiểm thử

Các lệnh được chạy tuần tự; `npm run test:docker` không chạy đồng thời với
`npm test`.

| Lệnh / kiểm tra | Kết quả |
|---|---|
| `docker compose config --quiet` | PASS |
| `docker compose ps` | PASS — các service đang chạy; PostgreSQL healthy |
| `docker compose exec -T nginx nginx -t` | PASS |
| HTTP Chat qua `http://localhost:8080` | PASS — trang chủ và `/health` trả 200 |
| pgAdmin qua `http://127.0.0.1:5050` | PASS — login và truy cập PostgreSQL/database |
| HTTP security headers và CSP | PASS |
| HTTP `/metrics`, `/stub_status` qua Nginx | PASS — đều trả 404 |
| PostgreSQL role check | PASS — runtime không superuser; exporter least-privilege; bootstrap không đổi |
| Owner transfer/migration dry run | PASS — trên bảng hiện có trong transaction rollback |
| Dữ liệu PostgreSQL | PASS — số hàng trước/sau giữ nguyên |
| Port bindings thực tế | PASS — không public DB/exporters/Loki/Promtail; admin bind loopback |
| `npm test` | PASS — 9/9 |
| `npm run test:docker` | PASS — migration cũ chạy lặp, history/session sau restart, session expiry |
| `npm run test:monitoring` | PASS — 5/5 targets, 12/12 panel |
| `npm run test:logging` | PASS — LogQL, Promtail targets, canary và restart persistence |

`test:docker` tạo schema legacy kiểm thử và dữ liệu kiểm thử được giữ lại theo
thiết kế script. Không xóa record, schema, volume hoặc dữ liệu người dùng.
pgAdmin lưu cấu hình trong named volume `pgadmin_data`. Mật khẩu khởi tạo được
đọc từ `.secrets/pgadmin_admin_password`; mật khẩu PostgreSQL runtime ở
`.secrets/app_runtime_password`. Không ghi các giá trị này ra log/báo cáo.

## 7. Kết luận

Hệ thống Chat, PostgreSQL, pgAdmin, Nginx, monitoring và logging đang hoạt
động; kiểm thử ứng dụng, Docker, Prometheus/Grafana và Loki/Promtail đều PASS.
Ứng dụng kết nối bằng role không-superuser; role bootstrap vẫn nguyên trạng.
pgAdmin cho phép xem database qua backend network và chỉ bind loopback. Nginx
có security headers/CSP, database/exporters/logging không publish cổng host,
và secret/local dependencies không được theo dõi bởi Git.

**Mức đáp ứng:** đáp ứng yêu cầu chức năng và hardening cơ bản cho môi trường
demo môn học. Rủi ro còn lại gồm cAdvisor/Docker socket, Prometheus loopback
không auth, HTTP không TLS và Promtail EOL; không làm hỏng chức năng đã kiểm
thử.

**READY FOR REVIEW.** Không commit/push/merge.
