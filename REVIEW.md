# Bàn giao — READY FOR REVIEW

> Cập nhật sửa CSP: xem [CSP_REVIEW.md](CSP_REVIEW.md). Hash cũ sai vì băm CRLF trước chuẩn hóa của HTML parser. Đã sửa hash script/style, cố định LF, bổ sung test hồi quy; kết quả mới nhất 9/9 test PASS và 3 kiểm tra Docker PASS. Xác nhận UI thực tế bằng Chrome vẫn NOT TESTED trong automation.

> Lượt kiểm tra bổ sung giao diện/Nginx: xem [UI_NGINX_REVIEW.md](UI_NGINX_REVIEW.md). Kết quả mới nhất là 8/8 test PASS, 3 kiểm tra Docker PASS; UI vẫn NOT TESTED do không có browser khả dụng. Backend đã bỏ publish cổng 3000 và Nginx đã bổ sung security headers. Các nội dung bên dưới ghi lại đợt bàn giao MVP trước đó.

Ngày: 22/10/2026. Workspace: `E:\DeTai32_chat`.

## Thay đổi

| File | Nội dung |
| --- | --- |
| `server.js` | Session PostgreSQL; kiểm tra secret; giới hạn bcrypt theo byte; phân quyền phòng và API thêm thành viên; xác thực lại session trên mỗi sự kiện; ngắt socket khi logout/đổi session/hết hạn; acknowledgement; migration lúc startup |
| `init.sql` | Thêm users, cột người gửi, rooms và room_members; migration cộng thêm, có transaction, chạy lại được; giữ tin nhắn cũ |
| `index.html` | Thêm thành viên; chỉ xác nhận phòng sau acknowledgement; giữ bản nháp nếu gửi thất bại; quay về đăng nhập khi server ngắt socket |
| `package.json`, `package-lock.json` | connect-pg-simple, socket.io-client cho kiểm thử; lệnh test/test:docker |
| `compose.yaml` | Đưa monitoring có sẵn vào profile tùy chọn, MVP mặc định chỉ app/PostgreSQL/Nginx |
| `Dockerfile`, `.dockerignore` | npm ci; không đưa .env, node_modules và Git vào image |
| `.gitignore`, `.env.example` | Cho phép theo dõi cấu hình mẫu, tiếp tục bỏ qua secret thật |
| `README.md` | Hướng dẫn chạy, biến môi trường, quyền phòng, migration, kiểm thử và giới hạn MVP |
| `test/chat.test.js` | Kiểm thử HTTP/Socket.IO qua Nginx với PostgreSQL thật |
| `scripts/verify-docker.js` | Kiểm thử migration schema cũ, restart app và session hết hạn |
| `REVIEW.md` | Báo cáo này |

`.env` được tạo riêng trên máy bằng giá trị ngẫu nhiên vì workspace chưa có cấu hình; tệp bị Git bỏ qua. Không đưa giá trị secret vào báo cáo.

## Kết quả kiểm thử thực tế

| Hạng mục | Kết quả | Bằng chứng |
| --- | --- | --- |
| Cú pháp server và JavaScript inline | PASS | node --check và vm.Script |
| Docker Compose build/start | PASS | app/Nginx chạy, PostgreSQL healthy |
| Health kết nối PostgreSQL | PASS | HTTP 200 qua localhost:8080 |
| Đăng ký, validation, trùng tên, sai mật khẩu | PASS | npm test |
| Đăng nhập, cookie session, xoay session và thu hồi phiên cũ | PASS | npm test |
| Chặn Socket.IO không đăng nhập | PASS | connect_error UNAUTHORIZED |
| Chủ phòng/thành viên, chặn người ngoài và chặn gửi ngoài phòng | PASS | npm test |
| Realtime và danh tính người gửi phía server | PASS | Hai client WebSocket qua Nginx nhận cùng message ID |
| WebSocket và HTTP long-polling | PASS | Các client test dùng rõ từng transport |
| Lưu và tải lại lịch sử | PASS | Message ID/nội dung khớp sau rejoin và restart app |
| Đăng xuất ngắt nhiều socket của cùng session | PASS | WebSocket và polling đều nhận disconnect; cookie cũ vô hiệu |
| Migration từ schema cũ, chạy lại hai lần | PASS | Schema test riêng, giữ tin nhắn cũ, ghi được cột mới |
| Session và quyền phòng qua restart app | PASS | test:docker |
| Session hết hạn không thể gửi tin nhắn | PASS | Làm hết hạn session test, nhận disconnect, SQL xác nhận không có tin trái phép |
| Kiểm tra thay đổi Git | PASS | git diff --check; không commit/push/merge |
| Thao tác giao diện trên trình duyệt thật/mobile | NOT TESTED | Đã kiểm tra cú pháp, chưa kiểm thử UI bằng trình duyệt |
| Hết hạn tự nhiên sau 24 giờ, tải lớn và môi trường HTTPS | NOT TESTED | Ngoài lượt kiểm thử MVP; expiry được kiểm tra bằng session test hết hạn |

`npm test`: 6 test PASS (gồm test cha), 0 FAIL. `npm run test:docker`: 3 kiểm tra PASS. Không còn FAIL chưa khắc phục trong những kiểm tra đã chạy. Lần tải image đầu bị TLS handshake timeout; thử lại thành công.

## Dữ liệu và trạng thái vận hành

- Không xóa dữ liệu, không chạy down -v, DROP hoặc TRUNCATE. Các tài khoản/phòng/tin nhắn/schema kiểm thử được giữ lại.
- Docker ban đầu chưa có project chạy; lần triển khai này tạo volume `detai32_chat_postgres_data`. Khả năng nâng cấp được kiểm thử riêng bằng schema legacy trong PostgreSQL thật, không phải bằng một database production có sẵn.
- Dịch vụ được giữ chạy để review tại http://localhost:8080; PostgreSQL không mở cổng ra host.
- Nginx và cấu hình Prometheus gốc được đọc và giữ nguyên; không bổ sung monitoring/logging mới.

## Giới hạn còn lại

- Phòng legacy công khai cho tài khoản đã đăng nhập; phòng mới chỉ chủ phòng/thành viên. Chủ phòng có thể thêm tài khoản đã tồn tại. Chưa có thu hồi quyền/đổi chủ phòng.
- Lịch sử chỉ 50 tin gần nhất; chưa phân trang, gửi tệp, chống spam, bảo đảm exactly-once hoặc đồng bộ bù toàn bộ tin khi mạng gián đoạn.
- Cookie đang dùng HTTP local (`secure: false`); cần cấu hình HTTPS/cookie phù hợp nếu triển khai công khai.
- Khi không phát sinh sự kiện, socket có session hết hạn được kiểm tra theo chu kỳ 30 giây. Logout chủ động ngắt ngay các socket của session.
- Chưa kết luận chất lượng hiển thị/khả năng thao tác trên trình duyệt vì chưa có kiểm thử UI thực tế.

Trạng thái: **READY FOR REVIEW**. Không commit/push/merge Git.
