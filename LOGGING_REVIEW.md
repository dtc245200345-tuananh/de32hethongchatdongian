# Loki + Promtail + LogQL — READY FOR REVIEW

Ngày 22/10/2026. Workspace E:\DeTai32_chat.

## Service và lưu trữ

- `loki`: grafana/loki:3.5.1, schema v13/TSDB/filesystem, replica 1, WAL bật. Volume loki_data mount /loki chứa WAL, index, cache, chunks.
- `promtail`: grafana/promtail:3.5.0, đọc Docker Logs API qua unix socket; volume promtail_data lưu /var/lib/promtail/positions.yml. Hai phiên bản cùng dòng 3.5 đã được kiểm thử ingest/query thực tế.
- Cả hai dùng profile monitoring hiện có, không publish cổng host. Network logging internal; Grafana tham gia network này để truy cập Loki. Không mở 3100/9080 ra host/Internet.
- Datasource Loki được provisioning qua file mới, UID chat-loki, URL http://loki:3100. Không thay file datasource Prometheus, UID chat-prometheus hoặc dashboard de32-chat-monitoring.

## Thu thập log và bảo vệ dữ liệu

Docker Desktop Windows đang chạy Linux containers. Promtail đọc stream qua Docker API thay vì bind đường dẫn log từ ổ Windows hoặc phụ thuộc layout storage driver. Đã kiểm chứng socket /var/run/docker.sock có mode 660 root:root và Promtail UID 0 đọc được. Không cần mount database, secret files hoặc thư mục ứng dụng vào Promtail.

Chỉ app/nginx có label de32.logging=true. Docker service discovery được relabel thành job=nodejs/nginx, service=app/nginx, project=detai32_chat. Loki thêm service_name=app/nginx. Labels thực tế được lưu trong evidence/logging.json.

Nginx access log đổi sang JSON có kind=chat_safe và trường safe chỉ chứa method đã whitelist, route cố định hoặc unmatched, status, duration, bytes. Không ghi raw URL/query string, IP, user-agent, referer, Cookie/Authorization, request body. Request WebSocket được ghi dưới route unmatched, không có sid hoặc room.

Node.js tiếp tục logic Chat hiện có; chỉ bổ sung log HTTP an toàn từ middleware metrics và đổi log lifecycle sang socket_connected/socket_disconnected/server_started, không có username/socket ID. Không log nội dung tin nhắn hoặc ID phòng. Các console.error thô không được đẩy vào Loki.

Promtail parse JSON, yêu cầu marker chat_safe, lấy trường safe và áp dụng regex whitelist trên toàn bộ dòng. Bất kỳ dòng raw, stack/error hoặc giá trị ngoài mẫu đều bị drop trước khi push. Không thu thập PostgreSQL logs, vì SQL/error có thể chứa dữ liệu riêng tư. Docker logs cục bộ vẫn có thể chứa stderr chẩn đoán gốc; chính sách này kiểm soát những gì được lưu trong Loki, không khẳng định toàn bộ diagnostic log của mọi container đã được scrub.

Verifier tạo canary ngẫu nhiên dùng trong mật khẩu test, query/path, header token/cookie, room và tin nhắn test. LogQL kiểm tra không có canary; các log trả về đều phải khớp safe vocabulary và labels cho phép. Cookie session thật chỉ được kiểm tra trong bộ nhớ, không đưa vào query LogQL hoặc báo cáo. Không kiểm thử bằng dữ liệu cá nhân thật.

## Kết quả kiểm thử thực tế

| Kiểm tra | Trạng thái | Minh chứng |
| --- | --- | --- |
| docker compose config --quiet | PASS | Cấu hình hợp lệ |
| Build/start và docker compose ps -a | PASS | Loki/Promtail đang chạy; PostgreSQL giữ nguyên container/volume |
| Loki verify-config, Promtail check-syntax, nginx -t | PASS | evidence/logging-config-check.txt |
| Loki readiness | PASS | HTTP 200, body ready qua mạng nội bộ/Grafana proxy |
| Promtail readiness và targets | PASS | Ready; 2/2 target app/nginx; evidence/promtail-targets.html |
| Promtail gửi log | PASS | promtail_sent_entries_total >0 và log xuất hiện trong Loki |
| Grafana Loki datasource health | PASS | API status OK |
| Bốn truy vấn LogQL | PASS | Có stream/log hoặc numeric count >0; evidence/logging.json |
| Canary dữ liệu riêng tư và nhãn | PASS | Không có canary trong Loki, safe shape và labels được kiểm tra |
| Log bền vững qua restart | PASS | Exact timestamp+line trước restart vẫn tìm được sau restart Loki/Promtail |
| Promtail positions bền vững | PASS | Các cursor Docker vẫn còn trong named volume sau restart |
| Không public Loki/Promtail | PASS | Compose không có ports, network logging internal |
| Chat HTTP, WebSocket/polling, session và lịch sử | PASS | npm test và test:docker |
| npm test | PASS | 9 test, 0 FAIL; evidence/logging-regression.txt |
| npm run test:docker | PASS | 3 kiểm tra; evidence/logging-docker.txt |
| Prometheus | PASS | 5/5 target UP sau triển khai logging |
| Grafana Monitoring | PASS | 12/12 panel có numeric frames thật; evidence/logging-monitoring-check.txt và monitoring.json |
| Hình thức Grafana Explore/ảnh chụp trên browser | NOT TESTED bằng automation | Chưa có browser khả dụng; cần chụp theo checklist |

## LogQL đã có dữ liệu

```logql
{job="nginx"}
{job="nginx"} |= "GET"
sum(count_over_time({job="nginx"}[5m]))
{job="nodejs"}
```

Mỗi truy vấn được gọi qua Grafana Loki datasource proxy, không push log giả trực tiếp để tạo kết quả. Traffic thực gồm GET /health, tải trang, API tài khoản, WebSocket join/send/disconnect. Các dòng gửi/nhận chat không chứa nội dung tin nhắn; chỉ access/lifecycle log đi vào Loki. Số dòng/count tại lần kiểm tra cuối nằm trong evidence/logging.json và bảng snapshot bên dưới.

Ví dụ log thực an toàn:

```text
http method=GET route=/health status=200 duration=0.003 bytes=38
http method=POST route=/api/logout status=200 duration=0.003362
socket_connected
```

## File thay đổi trong lượt này

- compose.yaml: thêm Loki/Promtail, named volumes, logging network; label chọn app/nginx; Grafana thêm network logging.
- loki/config.yml (mới): TSDB/filesystem/WAL trong volume bền vững.
- promtail/config.yml (mới): Docker discovery, checkpoint, relabel và privacy whitelist.
- grafana/provisioning/datasources/loki.yml (mới): datasource Loki, không đổi Prometheus.
- nginx/default.conf: safe access log format và tắt access log listener stub_status để tránh noise; giữ nguyên CSP/security headers/proxy.
- server.js: safe HTTP/lifecycle logs, bỏ username/socket ID khỏi lifecycle log; không sửa nghiệp vụ Chat.
- scripts/verify-logging.js (mới), package.json: npm run test:logging và kiểm thử canary/persistence/LogQL.
- README.md, LOGGING_REVIEW.md, evidence/logging*: hướng dẫn và kết quả.

Không sửa schema/init.sql, nguồn dashboard Monitoring hoặc promtool scrape targets. Không xóa database, record, volume và không chạy down -v. Dữ liệu test được giữ lại. Không hardcode mật khẩu vận hành, không commit/push/merge Git.

## Lệnh kiểm tra

```powershell
docker compose config --quiet
docker compose up -d --build
docker compose ps -a
docker compose exec -T grafana wget -qO- http://loki:3100/ready
docker compose exec -T grafana wget -qO- http://promtail:9080/ready
docker compose exec -T grafana wget -qO- http://promtail:9080/targets
docker compose exec -T nginx nginx -t
docker compose exec -T loki /usr/bin/loki '-config.file=/etc/loki/config.yml' '-verify-config=true'
docker compose exec -T promtail /usr/bin/promtail '-config.file=/etc/promtail/config.yml' '-check-syntax'
npm run test:logging
npm run test:monitoring
npm test
npm run test:docker
```

Local .env hiện bật COMPOSE_PROFILES=monitoring; ở máy khác dùng --profile monitoring khi cần. Script test:logging restart riêng Loki/Promtail để kiểm tra độ bền log, không xóa volume. Mật khẩu Grafana được đọc từ secret local, không in ra.

## Vấn đề đã xử lý và giới hạn

1. Lọc stream stdout tại bước relabel discovery ban đầu làm 0 target. Đã bỏ điều kiện metadata đó; dùng marker/whitelist nội dung để loại log không an toàn. Kết quả thực tế 2/2 target và sender counter tăng.
2. Loki có thể trả 503 trong thời gian đầu ingester khởi động; sau đó ready. Verifier chờ readiness thay vì báo PASS ngay khi container chạy.
3. Promtail đã EOL ngày 02/03/2026, được giữ theo yêu cầu môn học. Hệ thống mới nên chuyển sang [Grafana Alloy theo tài liệu Grafana](https://grafana.com/docs/grafana-cloud/send-data/alloy/set-up/migrate/from-promtail/).
4. Promtail chạy root để đọc Docker socket; mount :ro không giới hạn quyền Docker API. Chỉ dùng trong môi trường Docker quản trị tin cậy, không xem đây là hardening production đầy đủ.
5. Loki auth_enabled=false vì chạy trên network internal, người dùng truy cập qua Grafana có đăng nhập. Không public port 3100/9080. Chưa có TLS/multitenancy.
6. Chưa đặt retention xóa tự động để tránh xóa dữ liệu trong bước này; cần quản lý dung lượng volume lâu dài. Chỉ lưu safe access/lifecycle log, không có raw stacktrace/SQL logs nên chi tiết chẩn đoán bị giới hạn có chủ đích.
7. Docker logs API có thể mất log khi Docker đã rotate trước khi collector đọc; checkpoint giúp tiếp tục đọc nhưng chưa bảo đảm exactly-once trong mọi sự cố. Các bài kiểm thử restart/persistence hiện tại đã PASS, chưa thử host crash/mất điện.
8. Các log trước khi áp dụng safe format không được nhập vào Loki. UI Chat đã được người dùng xác nhận từ trước; không suy diễn thành đã kiểm thử trực quan Grafana Explore.

Tham khảo cấu hình: [Promtail configuration](https://grafana.com/docs/loki/latest/send-data/promtail/configuration/), [Loki filesystem/TSDB examples](https://grafana.com/docs/loki/latest/configure/examples/configuration-examples/).

## Ảnh minh chứng cần chụp

Chưa có ảnh browser tự động. Tại http://127.0.0.1:3001, đăng nhập bằng secret local và chọn Explore → Loki, khoảng Last 15 minutes:

1. `01-logging-compose.png`: docker compose ps -a có Loki/Promtail đang chạy, không public ports.
2. `02-logging-readiness-targets.png`: terminal readiness Loki/Promtail và targets 2/2 ready.
3. `03-loki-datasource.png`: datasource Loki health OK; không chụp mật khẩu/token.
4. `04-logql-nginx.png`: {job="nginx"} có access log thực.
5. `05-logql-get.png`: {job="nginx"} |= "GET" có kết quả.
6. `06-logql-count.png`: sum(count_over_time({job="nginx"}[5m])) có count >0; tạo GET /health nếu cửa sổ 5 phút hết dữ liệu.
7. `07-logql-nodejs.png`: {job="nodejs"} có safe HTTP/socket lifecycle log.
8. `08-monitoring-preserved.png`: 5 targets UP và dashboard Monitoring vẫn có dữ liệu.
9. `09-regression-pass.png`: npm test, test:docker, test:logging PASS.

Trạng thái: **READY FOR REVIEW**.
