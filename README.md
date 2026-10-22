# Đề 32 — Hệ thống Chat / Messaging

MVP dùng Node.js, Express, Socket.IO, PostgreSQL và HTML/CSS/JavaScript. Tiếp tục từ mã nguồn hiện có.

## Chạy bằng Docker Compose

Yêu cầu Docker Engine/Desktop, Docker Compose v2 và Node.js 22+ để tạo secret/chạy kiểm thử trên máy.

```powershell
Copy-Item .env.example .env
# Sửa DB_PASSWORD và SESSION_SECRET trong .env; SESSION_SECRET ít nhất 32 ký tự.
node scripts/setup-monitoring.js
docker compose up -d --build
docker compose ps
```

Nếu đã có `.env`, giữ nguyên tệp và mật khẩu database hiện tại. Không ghi đè `.env` đang dùng.

- Giao diện qua Nginx: http://localhost:8080
- Backend chỉ dùng cổng 3000 trong mạng Docker, không publish ra host; truy cập qua Nginx cổng 8080.
- Kiểm tra database: http://localhost:8080/health
- pgAdmin: http://127.0.0.1:5050; chỉ bind loopback.

Compose tự đọc `.env`. Khi chạy `npm start` ngoài Docker, cần tự nạp biến môi trường (Node 22+: `node --env-file=.env server.js`), PostgreSQL truy cập được tại DB_HOST/DB_PORT. PostgreSQL trong Compose không mở cổng ra host.

## Sử dụng

1. Đăng ký tài khoản (tên 3–50 ký tự ASCII, mật khẩu ít nhất 8 ký tự và tối đa 72 byte UTF-8); đăng ký thành công tự đăng nhập.
2. Nhập tên phòng và bấm tham gia. Người đầu tiên tạo phòng là chủ phòng.
3. Chủ phòng nhập tên tài khoản đã đăng ký để thêm thành viên. Thành viên sau đó mới có thể vào phòng, đọc lịch sử, gửi và nhận tin nhắn.
4. Mở trình duyệt khác/cửa sổ riêng tư với tài khoản thành viên để kiểm tra realtime.
5. Đăng xuất sẽ hủy session và ngắt toàn bộ socket của session đó, gồm nhiều tab. Những phiên đăng nhập độc lập khác của cùng tài khoản vẫn hoạt động.

Phòng có sẵn trong dữ liệu cũ được giữ ở chế độ công khai cho người đã đăng nhập (`owner_id IS NULL`). Không gán quyền sở hữu lịch sử cho người truy cập đầu tiên. Phòng mới là riêng tư. Chưa có giao diện liệt kê phòng, xóa thành viên hay đổi chủ phòng.

## Database và bảo toàn dữ liệu

`init.sql` chạy khi khởi tạo volume mới và được backend áp dụng lại khi khởi động. Migration dùng CREATE IF NOT EXISTS, ALTER ADD COLUMN IF NOT EXISTS và INSERT ON CONFLICT, không DROP/TRUNCATE/DELETE dữ liệu.

- `users`: tài khoản và bcrypt hash.
- `messages`: nội dung, phòng, người gửi, thời gian; tin nhắn cũ có thể thiếu user_id/username.
- `rooms`: tên phòng và chủ phòng.
- `room_members`: quyền thành viên.
- `session`: session PostgreSQL, được connect-pg-simple tạo tự động.

`chatuser` là tài khoản bootstrap PostgreSQL, vẫn giữ nguyên và chỉ được dùng bởi các tác vụ khởi tạo/quản trị trong Compose. Ứng dụng kết nối bằng role `chat_runtime` không phải superuser. `postgres-runtime-role-init` đọc mật khẩu từ `.secrets/app_runtime_password`, cấp quyền CONNECT và CREATE trong schema `public`, rồi chuyển owner của các bảng chat/session và sequence liên quan sang role runtime. Không xóa hoặc sửa nội dung các hàng hiện có. Điều này cho phép ứng dụng tiếp tục chạy migration lặp lại mà không dùng quyền superuser.

Đăng nhập pgAdmin bằng `admin@de32.com`; mật khẩu khởi tạo ở `.secrets/pgadmin_admin_password`. Trong pgAdmin, thêm server với host `postgres`, port `5432`, maintenance database `chatdb`, username `chat_runtime`, và mật khẩu trong `.secrets/app_runtime_password`. Không kết nối pgAdmin bằng tài khoản bootstrap. Cấu hình server đã lưu trong volume `pgadmin_data`; đổi file secret không tự thay mật khẩu trong database pgAdmin đã khởi tạo.

Giữ nguyên tên project Compose để tiếp tục dùng đúng volume hiện tại. Với dữ liệu quan trọng, sao lưu PostgreSQL trước khi cập nhật schema. Không chạy `docker compose down -v` vì sẽ xóa volume. Thay đổi DB_PASSWORD trong `.env` không tự đổi mật khẩu database đã tồn tại.

## Kiểm thử

```powershell
npm ci
npm test
npm run test:docker
```

Kiểm thử tích hợp yêu cầu Compose đang chạy tại cổng 8080. Có thể đặt `TEST_BASE_URL` để trỏ sang server kiểm thử riêng. Test tạo tài khoản/phòng/tin nhắn có hậu tố ngẫu nhiên và giữ lại dữ liệu đó, không xóa dữ liệu hiện có.

`npm run test:docker` dùng project Compose ở thư mục hiện tại: tạo schema kiểm thử riêng để kiểm tra migration từ schema cũ hai lần, sau đó khởi động lại container app để kiểm tra session và lịch sử còn tồn tại. Lệnh này làm gián đoạn kết nối chat trong lúc app khởi động lại; chạy khi không có người sử dụng. Schema kiểm thử được giữ lại.

Phạm vi: health, input không hợp lệ, đăng ký trùng, sai mật khẩu, session, chặn socket vô danh, phân quyền phòng, chủ phòng thêm thành viên, gửi nhận realtime, định danh người gửi phía server, tải lại lịch sử, chặn gửi ngoài phòng, đăng xuất ngắt nhiều socket và chặn tái sử dụng cookie cũ.

## API và Socket.IO

HTTP: `POST /api/register`, `/api/login`, `/api/logout`; `GET /api/me`, `/health`; `POST /api/rooms/members` nhận `{room, username}` (chỉ chủ phòng).

Socket yêu cầu cookie session. Client gửi `join-room` (chuỗi tên phòng), `chat-message` (`{room,message}`); server trả acknowledgement `{ok,...}` và phát `chat-history`, `chat-message`, `chat-error`. Lịch sử giới hạn 50 tin mới nhất, hiển thị theo thứ tự thời gian. Nội dung tối đa 2000 ký tự. Room Socket.IO có tiền tố riêng để tránh trùng kênh session/socket ID. Mỗi sự kiện kiểm tra lại session và quyền trong database; socket hết session được ngắt trong tối đa khoảng 30 giây nếu không gửi sự kiện.

## Phạm vi MVP

Session lưu PostgreSQL và có hạn 24 giờ. Chưa có phân trang lịch sử, gửi file, thông báo, giới hạn tần suất, triển khai HTTPS hoặc bảo đảm gửi đúng một lần khi mạng gián đoạn. Khi gửi hết thời gian chờ, kiểm tra lịch sử trước khi gửi lại để tránh trùng.

Cấu hình Prometheus/Grafana đã hoàn thiện trong profile `monitoring`, cùng cAdvisor, exporter PostgreSQL/Nginx và Loki/Promtail. Đặt `COMPOSE_PROFILES=monitoring` trong `.env` hoặc dùng `--profile monitoring`. `/metrics` của app chỉ được scrape qua mạng Docker, truy cập qua cổng web 8080 trả 404.

```powershell
docker compose --profile monitoring up -d
```

Không lưu `.env` vào Git. Xem `REVIEW.md` để biết kết quả kiểm thử của lần bàn giao.

Thư mục `evidence/` chứa log/minh chứng vận hành cục bộ và được bỏ qua bởi Git. Chạy các script kiểm thử để tạo lại minh chứng trên máy; không đưa `.env`, `.secrets/` hoặc dữ liệu volume Docker lên repository.

## Monitoring

Trước khi bật monitoring lần đầu, tạo secret bằng Node.js; lệnh không in mật khẩu và không ghi đè secret đã tồn tại:

```powershell
node scripts/setup-monitoring.js
docker compose --profile monitoring config --quiet
docker compose --profile monitoring up -d --build
docker compose ps -a
npm run test:monitoring
```

Local `.env` hiện đã bật profile, nên `docker compose up -d --build` cũng chạy toàn bộ monitoring. Nếu chỉ cần Chat ở máy khác, bỏ COMPOSE_PROFILES trong `.env`. Giữ `.secrets/` cùng volume đang dùng; không xóa hoặc tự đổi mật khẩu khi Grafana/pgAdmin đã có database.

- Chat: http://localhost:8080
- pgAdmin: http://127.0.0.1:5050; đăng nhập `admin@de32.com`. Để xem dữ liệu, tạo kết nối server tới `postgres:5432`, database `chatdb`, user `chat_runtime`; mật khẩu được lưu cục bộ trong `.secrets/app_runtime_password`.
- Prometheus: http://127.0.0.1:9090, trang Targets tại `/targets`.
- Grafana: http://127.0.0.1:3001; tài khoản `admin`, mật khẩu nằm trong file cục bộ `.secrets/grafana_admin_password`. Mở file bằng trình soạn thảo trên máy; không đưa mật khẩu vào báo cáo/Git. Secret admin chỉ được Grafana dùng khi khởi tạo database lần đầu.
- Dashboard: http://127.0.0.1:3001/d/de32-chat-monitoring — thư mục De32, tên De32 Chat Monitoring, 12 panel và refresh 5 giây. Datasource Prometheus được provisioning tự động.

Prometheus scrape mỗi 5 giây, retention 7 ngày. Dashboard có CPU/RAM/network container, PostgreSQL UP/connections, Nginx connections/requests, HTTP request rate/p95 duration và Socket.IO connections. Chờ ít nhất 15–30 giây sau startup và phát sinh traffic trước khi đánh giá biểu đồ rate/p95. Socket gauge bằng 0 khi không có người dùng là hợp lệ.

HTTP metrics dùng labels cố định `method`, `route`, `status_code`; đường dẫn không khớp là `unmatched`. Không dùng username, room ID, query string hoặc nội dung chat làm labels. HTTP counters/histogram chỉ đo Express, không bao gồm frames WebSocket hoặc request polling do engine Socket.IO xử lý; gauge đếm socket đã xác thực.

`postgres-metrics-init` là tác vụ chạy một lần (Exited 0 là thành công), tạo tài khoản chat_metrics và cấp CONNECT/pg_monitor; không đọc bảng users/messages. Exporter lấy password từ Docker secret. Script hoạt động trên cả volume PostgreSQL cũ, không yêu cầu reset/init lại database.

cAdvisor cần quyền privileged, Docker socket và mount host read-only để đọc số liệu container. Trên Docker Desktop đang dùng containerd snapshotter, mount `/run/containerd` vào `/containerd` là cần thiết. Đây là thành phần có quyền host cao; không publish cổng và không mở ra Internet. Metrics phản ánh Linux VM/container của Docker Desktop, không phải tổng RAM/CPU Windows.

Prometheus/Grafana chỉ bind 127.0.0.1; exporter, PostgreSQL, Node.js và Nginx stub_status 8081 không publish cổng. Không forward các cổng quản trị ra Internet. Không dùng `docker compose down -v`. Xem `MONITORING_REVIEW.md` và `evidence/monitoring.json` cho kết quả thực tế và danh sách ảnh cần chụp.

```powershell
docker compose exec -T prometheus promtool check config /etc/prometheus/prometheus.yml
docker compose exec -T nginx nginx -t
docker compose logs --tail 50 prometheus grafana cadvisor postgres-exporter nginx-exporter
npm test
npm run test:docker
```

## Kiểm tra Nginx và giao diện

Xem `UI_NGINX_REVIEW.md` để biết kết quả mới nhất, minh chứng và checklist thao tác giao diện thủ công. Công cụ browser automation trong phiên kiểm thử không có browser khả dụng; các luồng UI chưa được đánh dấu PASS.

```powershell
docker compose config --quiet
docker compose ps
docker compose exec -T nginx nginx -t
docker compose logs --tail 100 nginx app
curl.exe -I http://localhost:8080/
npm test
npm run test:docker
```

Nginx trả CSP, nosniff, chống nhúng iframe, Referrer-Policy, Permissions-Policy và Cache-Control no-store, bao gồm các phản hồi lỗi. CSP dùng SHA-256 riêng cho script và style nội tuyến, không dùng `unsafe-inline`. Nếu sửa script/style trong `index.html`, phải cập nhật hash trong `nginx/default.conf` và build lại app trước khi kiểm thử. **Trước khi băm, chuẩn hóa CRLF và CR thành LF như HTML parser của trình duyệt; không trim nội dung.** `.gitattributes` giữ index.html và cấu hình Nginx ở LF. `test/nginx.test.js` tính hash từ script/style thực tế được HTTP phục vụ sau chuẩn hóa, kiểm tra đúng directive và có ca hồi quy CRLF/LF. Kết nối WebSocket cho phép scheme ws/wss để dùng qua hostname LAN. Chưa bật HSTS vì dịch vụ hiện dùng HTTP local.

Sau khi cập nhật CSP, mở http://localhost:8080 trong Chrome và nhấn **Ctrl+Shift+R**. Xác nhận hết lỗi CSP trong Console và trang chuyển từ “Đang khởi tạo...” sang form đăng nhập hoặc giao diện chat. Xem `CSP_REVIEW.md` để biết nguyên nhân và kết quả sửa lỗi CRLF/LF.

Khi chỉ sửa cấu hình Nginx: chạy `docker compose exec -T nginx nginx -t`, rồi `docker compose exec -T nginx nginx -s reload`. Khi đổi mapping cổng app, chạy `docker compose up -d --no-deps app nginx`; không cần xóa volume.

## Logging: Loki + Promtail + LogQL

Loki 3.5.1 và Promtail 3.5.0 dùng chung profile `monitoring`. Chạy `docker compose --profile monitoring up -d --build` để bật cả monitoring/logging. Không xóa volume cũ. Loki lưu TSDB/chunks/WAL trong volume `loki_data`; Promtail lưu cursor đọc Docker logs trong `promtail_data`.

Promtail đọc Docker logs API qua `/var/run/docker.sock` trong Linux VM Docker Desktop; không mount đường dẫn log Windows hoặc đọc trực tiếp `/var/lib/docker/containers`. Chỉ hai container có label `de32.logging=true` (app, nginx) được chọn. Nginx phát JSON access log đã bỏ IP, raw URL, query string, referer, user-agent, header/cookie và body. Node.js phát log HTTP dùng route template và sự kiện socket không có account/socket/room ID. Promtail chỉ đẩy trường `safe` đúng whitelist; log thô, stderr/error stack và dòng không đúng mẫu bị drop trước khi gửi Loki. Không thu thập PostgreSQL logs vì có thể chứa SQL/dữ liệu chat khi có lỗi.

Promtail cần đọc Docker socket (trên máy đã kiểm tra: socket 660 root:root, process Promtail chạy root). Mount `:ro` không biến Docker API thành API chỉ đọc; chỉ dùng trong môi trường Docker quản trị tin cậy. Loki/Promtail không publish host ports và dùng network `logging` internal. Loki không bật auth nội bộ; truy cập từ người dùng qua Grafana có đăng nhập, không forward port Loki ra Internet.

Grafana tại http://127.0.0.1:3001 → **Explore → datasource Loki** (`chat-loki`). Datasource Prometheus vẫn mặc định và dashboard Monitoring giữ nguyên. Chọn khoảng thời gian Last 15 minutes và thử:

```logql
{job="nginx"}
{job="nginx"} |= "GET"
sum(count_over_time({job="nginx"}[5m]))
{job="nodejs"}
```

Labels thực tế: job (nginx/nodejs), project (detai32_chat), service (nginx/app), service_name do Loki suy ra. Không dùng dữ liệu tài khoản/phòng/tin nhắn làm label. Có thể thêm `project="detai32_chat"` vào selector để giới hạn project.

```powershell
docker compose config --quiet
docker compose ps -a
docker compose exec -T grafana wget -qO- http://loki:3100/ready
docker compose exec -T grafana wget -qO- http://promtail:9080/ready
docker compose exec -T grafana wget -qO- http://promtail:9080/targets
curl.exe http://localhost:8080/health
npm run test:logging
npm run test:monitoring
npm test
npm run test:docker
```

`test:logging` tạo traffic và dữ liệu test thật, kiểm tra LogQL, datasource, canary riêng tư, sau đó **restart Loki/Promtail** để kiểm tra giữ log/cursor; không restart Chat trong lệnh này. Tài khoản/phòng/tin nhắn test được giữ lại. Loki có thể cần 15–30 giây sau startup để ready; collector retry nếu Loki chưa sẵn sàng. Log cũ theo định dạng trước khi triển khai không được nhập vào Loki. Cấu hình hiện chưa đặt retention xóa tự động; cần theo dõi dung lượng volume.

Promtail đã EOL từ 02/03/2026; dùng theo yêu cầu môn học. Với hệ thống mới, hướng thay thế là [Grafana Alloy](https://grafana.com/docs/grafana-cloud/send-data/alloy/set-up/migrate/from-promtail/). Xem `LOGGING_REVIEW.md` và `evidence/logging.json` cho kết quả, truy vấn và ảnh cần chụp.
