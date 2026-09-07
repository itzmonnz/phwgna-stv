# Phwgna Stv

Tiện ích dịch và nghe truyện trên Sáng Tác Việt của **phwgna**. Bản chính thức **luôn miễn phí**.

Đây là phần mềm **source-available**: mã được công khai để người dùng kiểm tra, nhưng không được sao chép, sửa đổi, đổi thương hiệu hoặc phân phối lại nếu chưa có sự cho phép của phwgna. Xem `LICENSE` và `TRADEMARK.md`.

## Cài nhanh

| Nhu cầu | Cách cài |
|---|---|
| PC | Chạy `Cai-dat-phwgna-STV.bat`, chọn **Dùng trên PC** |
| Điện thoại cùng Wi-Fi | Chọn **Dùng trên điện thoại**; wizard chuẩn bị Sunshine, điện thoại cài Artemis |
| Điện thoại ngoài nhà | Bật thêm Tailscale (tùy chọn) và đăng nhập cùng tài khoản trên hai máy |

Hướng dẫn đầy đủ, QR Artemis và cách xử lý lỗi nằm trong `HUONG-DAN-PHWGNA-STV.html`.

Không biết IP để thêm PC vào Artemis: chạy **Lay-IP-ket-noi-Sunshine.bat**. IP cùng Wi-Fi sẽ được hiện và tự sao chép để bạn chỉ cần bấm Dán trên điện thoại.

Wizard chỉ cài Sunshine và **không ghi đè cấu hình Sunshine** đang có. Để vuốt một ngón như trên điện thoại, chọn **Artemis → Cài đặt đầu vào → Chế độ màn hình cảm ứng → Chạm đa điểm**. Nếu máy không nhận tốt, chọn **Bàn di chuột (Tự nhiên – Nhấn đúp để kéo)** và vuốt hai ngón để cuộn. Xem các bước và cách xử lý lỗi trong [hướng dẫn cảm ứng](HUONG-DAN-PHWGNA-STV.html#cam-ung).

### Cài extension thủ công

1. Tải ZIP từ mục Releases của repository chính thức và giải nén.
2. Mở trang quản lý tiện ích của trình duyệt, bật Chế độ dành cho nhà phát triển.
3. Chọn **Load unpacked / Tải tiện ích đã giải nén** và chọn thư mục này.
4. Tự đăng nhập dịch vụ AI trong trình duyệt hoặc nhập API key của riêng bạn trong Cài đặt.

Không gửi API key, cookie hay mật khẩu cho người khác. Muốn cập nhật, tải bản mới từ Releases, giải nén và nạp lại. Muốn gỡ, dùng nút Xóa trong trang quản lý tiện ích.

## Xác minh bản chính thức

- Repository: https://github.com/itzmonnz/phwgna-stv
- Chủ sở hữu: `phwgna`
- Fingerprint Ed25519: `85ac74c199d0a6028bce843d6f68d7632317912b460aad1a7431193767ec9871`
- Metadata chữ ký và hash từng file nằm trong thư mục `_integrity`.

Bản sửa đổi, đổi icon hoặc đổi tên không phải bản chính thức. Nếu gặp bản giả mạo hoặc thu phí, hãy báo bằng GitHub Issue tại repository chính thức.
