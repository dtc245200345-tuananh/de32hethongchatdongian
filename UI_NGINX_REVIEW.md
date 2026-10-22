# Kiểm tra giao diện và Nginx — READY FOR REVIEW

> Báo cáo lịch sử của lượt kiểm tra Nginx trước. Sau phản hồi Chrome thực tế, phát hiện test hash cũ không chuẩn hóa CRLF/LF. Đã khắc phục trong [CSP_REVIEW.md](CSP_REVIEW.md); kết quả mới nhất 9 test PASS và 3 kiểm tra Docker PASS. CSP hiện dùng hash cho cả script/style, không còn unsafe-inline. Các số liệu 8 test và chính sách CSS trong nội dung bên dưới là trạng thái trước sửa CSP.

Ngày 22/10/2026, workspace `E:\DeTai32_chat`, URL http://localhost:8080.

## Phạm vi và công cụ

Đã đọc README.md, REVIEW.md, compose.yaml, nginx/default.conf, server.js, index.html và các test hiện tại. Không viết lại ứng dụng, không thay đổi logic nghiệp vụ, không triển khai thêm monitoring.

Đã gọi công cụ browser automation: `cua.getState()` trả `apps: [], browsers: []`. Thử `cua.createBrowserTab('iab', 'http://localhost:8080', {visible:true})` trả `Browser is not available: iab`. Vì vậy không thể thao tác giao diện thực tế trong phiên này. HTTP/client Socket.IO tự động không được coi là kiểm thử UI bằng trình duyệt.

## Kết quả theo kịch bản

| Kịch bản | Kết quả | Minh chứng/giới hạn |
| --- | --- | --- |
| UI đăng ký tài khoản | NOT TESTED | Không có browser khả dụng |
| UI đăng nhập | NOT TESTED | Có kiểm thử API, chưa thao tác form trên browser |
| UI tạo phòng | NOT TESTED | Chưa thao tác nút tham gia trên browser |
| UI chặn người ngoài, thêm thành viên và tham gia phòng | NOT TESTED | Có kiểm thử backend, chưa kiểm thử UI |
| UI chat realtime giữa hai phiên độc lập | NOT TESTED | Hai tài khoản/session được kiểm thử bằng Socket.IO client, không phải hai browser |
| UI reload và tải lại lịch sử | NOT TESTED | Lịch sử backend/restart PASS, UI chưa kiểm thử |
| UI đăng xuất và chuyển về form đăng nhập | NOT TESTED | Socket bị ngắt ở backend PASS, DOM/browser chưa kiểm thử |
| UI mobile, lỗi console và CSP enforcement trong browser | NOT TESTED | Hash CSP được kiểm tra bằng HTTP, chưa xác nhận thực thi bởi browser |
| Nginx HTTP HTML, API, Socket.IO client JavaScript | PASS | test/nginx.test.js; HTTP 200, MIME JavaScript |
| Nginx WebSocket | PASS | Client ép transport websocket gửi/nhận; access log có 101 Switching Protocols |
| Nginx polling GET/POST | PASS | Client ép polling gửi/nhận với WebSocket; access log có transport=polling HTTP 200 |
| Security headers trên 200, 400, 401, 404 | PASS | Kiểm tra giá trị thống nhất, không trùng; CSP hash khớp HTML đang phục vụ |
| CSP hash inline và không cho unsafe-inline/unsafe-eval trong script-src | PASS | test/nginx.test.js tính SHA-256 từ HTML thực tế |
| Node.js không publish trực tiếp ra host | PASS | Compose app chỉ expose 3000; không có ports; kiểm tra kết nối host riêng trong evidence/http-network.txt |
| PostgreSQL không publish ra host | PASS | docker compose config/ps |
| docker compose config --quiet và nginx -t | PASS | evidence/compose.txt |
| docker compose ps | PASS | Chỉ app, Nginx, PostgreSQL; database healthy |
| npm test | PASS | 8 test (gồm test cha), 0 FAIL; evidence/npm-test.txt |
| npm run test:docker | PASS | 3 kiểm tra PASS; migration giữ dữ liệu, restart giữ session/lịch sử, session hết hạn bị chặn |
| Rà soát log Nginx và app | PASS | Xem phân tích log bên dưới; còn gián đoạn có chủ đích khi restart |

## Lỗi phát hiện và đã sửa

1. App publish `0.0.0.0:3000`: đổi thành expose nội bộ, Nginx là đường vào ứng dụng qua host.
2. Thiếu security headers: thêm CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy và no-store với `always`; ẩn X-Powered-By và phiên bản Nginx trong response.
3. Lần test header đầu có 2 FAIL: Cache-Control gộp giá trị của Express với Nginx, nosniff bị trùng trên trang lỗi. Đã proxy_hide_header các header do Nginx quản lý; lần chạy cuối 8/8 PASS. Giữ kết quả lần đầu ở evidence/npm-test-first-run.txt.
4. Socket.IO location đặt Connection upgrade cho cả polling: đổi sang map theo Upgrade header và tắt proxy buffering. Giữ nguyên forwarding HTTP/1.1 và timeout. Host chuyển sang $http_host để giữ port 8080.

Cấu hình map/forwarding tham chiếu [hướng dẫn NGINX cho Node.js và WebSocket](https://docs.nginx.com/nginx/deployment-guides/load-balance-third-party/node-js/). Không bật HSTS trên HTTP local.

## File thay đổi trong lượt này

- `compose.yaml`: bỏ publish cổng app, dùng expose nội bộ.
- `nginx/default.conf`: điều kiện upgrade/polling, giữ Host có port, security headers, xử lý header upstream trùng.
- `test/chat.test.js`: cho client polling tham gia phòng, nhận và gửi tin sang WebSocket; xác nhận transport thực tế.
- `test/nginx.test.js` (mới): HTTP proxy, client JS, hash CSP và header trên response thành công/lỗi.
- `README.md`: cập nhật cổng nội bộ và lệnh kiểm tra Nginx/CSP.
- `REVIEW.md`: dẫn tới kết quả mới, giữ lại báo cáo MVP trước.
- `UI_NGINX_REVIEW.md` và `evidence/`: báo cáo và output thực tế, không lưu .env/cookie/session secret.

Không sửa server.js, index.html hoặc init.sql trong lượt này. Các thay đổi MVP chưa commit từ lượt trước vẫn được giữ.

## Minh chứng và lệnh kiểm tra

```powershell
docker compose config --quiet
docker compose ps
docker compose exec -T nginx nginx -t
docker compose logs --tail 100 nginx app
curl.exe -I http://localhost:8080/
npm test
npm run test:docker
```

Các tệp evidence/npm-test.txt, test-docker.txt, compose.txt, nginx-app.txt, transport-summary.json và http-network.txt ghi lại kết quả kiểm tra. Config được kiểm tra bằng --quiet và chỉ lưu thông tin cổng đã lọc, không ghi toàn bộ config chứa biến bí mật.

Access log trong cửa sổ thu thập có 32 response WebSocket 101 và 79 response polling 200 (gồm các lần chạy gần đây). App có npm SIGTERM khi test cố ý restart; Nginx có 502/connection refused ngắn ở các lần probe health trong thời gian app restart. Health/session/history sau restart đều PASS; không coi các dòng đó là lỗi ổn định đã được loại bỏ. Thông báo entrypoint không thể sửa default.conf là do bind mount read-only có chủ đích; nginx -t PASS và worker chạy bình thường.

Số tài khoản/tin nhắn từ trước lượt test là 8/5, sau kiểm thử là 14/11. Dữ liệu test được giữ lại; không reset database, xóa volume hoặc xóa bản ghi. Các schema legacy test cũng được giữ lại. Không commit/push/merge Git.

## Checklist thủ công còn chờ

Mỗi bước dưới đây hiện là NOT TESTED. Dùng một tên phòng mới có hậu tố ngày/giờ để tránh tác động phòng đang dùng. Không dùng hai tab bình thường cùng profile cho hai phiên độc lập vì chúng chia sẻ cookie.

1. Mở http://localhost:8080 trong cửa sổ thường A và cửa sổ riêng tư hoặc trình duyệt khác B. Mở DevTools Console/Network ở cả hai; xác nhận không lỗi JavaScript/CSP.
2. A đăng ký một tài khoản mới; xác nhận thấy đúng tên tài khoản và trạng thái đã kết nối. Đăng xuất, đăng nhập lại bằng form; kiểm tra sai mật khẩu rồi đúng mật khẩu.
3. B đăng ký tài khoản khác; xác nhận A và B hiển thị hai tên khác nhau.
4. A nhập tên phòng mới, bấm Tham gia phòng; xác nhận trạng thái đang ở đúng phòng. B nhập cùng tên trước khi được cấp quyền: phải thấy FORBIDDEN, không nhận lịch sử.
5. A nhập tên B và bấm Thêm thành viên. B tham gia lại: phải thành công. B thử thêm tài khoản khác vào phòng của A: phải bị từ chối.
6. A gửi `Xin chào từ A`; B phải thấy ngay, đúng người gửi/thời gian. B trả lời; A thấy ngay. Không cần reload. Nhập `<script>alert(1)</script>`: phải hiển thị văn bản, không chạy script.
7. Reload B: vẫn đăng nhập, bấm tham gia lại phòng (UI chưa tự lưu tên phòng sau reload); xác nhận thấy lịch sử đúng thứ tự. Tạo/vào phòng khác và xác nhận không nhận tin phòng cũ.
8. Mở thêm tab A2 trong cùng profile A, tham gia phòng. Đăng xuất A: A và A2 phải quay về form đăng nhập, không nhận/gửi được tin; B vẫn hoạt động. Reload A2 vẫn chưa đăng nhập. Đăng nhập lại A và vào phòng để kiểm tra lịch sử còn nguyên.
9. Trong Network xác nhận Socket.IO upgrade 101. Kiểm tra polling bằng client test hiện có (`npm test`); nếu cần xác nhận browser polling, dùng môi trường browser cho phép chặn riêng WebSocket và lặp lại bước gửi nhận, không sửa code ứng dụng chính.

Ghi tên trình duyệt/phiên bản, thời điểm, ảnh chụp/console và PASS/FAIL thực tế khi chạy checklist; không chuyển trạng thái trước khi thao tác.

## Giới hạn/lỗi còn tồn tại

- Chưa kiểm thử UI thực tế vì không có browser khả dụng; CSP enforcement bởi trình duyệt còn chờ xác minh.
- Restart app làm gián đoạn chat và có thể trả 502 ngắn; chưa triển khai zero downtime trong phạm vi MVP.
- HTTP local và cookie secure=false vẫn giữ nguyên. HTTPS/HSTS chưa triển khai.
- CSP cho CSS inline và các scheme ws/wss để tương thích giao diện hiện tại/hostname LAN; chưa siết theo domain triển khai cụ thể.
- Hash CSP cần cập nhật nếu sửa inline script. Chưa có thay đổi giao diện hoặc tính năng nâng cao trong lượt này.

Trạng thái: **READY FOR REVIEW**.
