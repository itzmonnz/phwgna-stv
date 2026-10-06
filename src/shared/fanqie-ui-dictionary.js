(function attachFanqieDictionary(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.STVAIFanqieDictionary = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Curated public interface labels, not collected reader/story data.
  const entries = [
    ['首页', 'Trang chủ'], ['书库', 'Kho truyện'], ['书架', 'Tủ sách'],
    ['原创榜', 'Bảng xếp hạng truyện gốc'], ['作家专区', 'Khu vực tác giả'],
    ['版权专区', 'Khu vực bản quyền'], ['作家福利', 'Chính sách hỗ trợ tác giả'],
    ['登录', 'Đăng nhập'], ['注册', 'Đăng ký'],
    ['请输入书名或作者名', 'Nhập tên truyện hoặc tác giả'],
    ['最新资讯', 'Tin mới'], ['更多', 'Xem thêm'], ['查看全部', 'Xem tất cả'],
    ['男频精选', 'Truyện chọn lọc cho nam'], ['女频精选', 'Truyện chọn lọc cho nữ'],
    ['男频排行榜', 'Xếp hạng truyện dành cho nam'], ['女频排行榜', 'Xếp hạng truyện dành cho nữ'],
    ['殿堂、金番作家', 'Tác giả danh tiếng và tác giả Kim Phiên'], ['成为作家', 'Trở thành tác giả'],
    ['最近更新', 'Mới cập nhật'], ['类型', 'Thể loại'], ['书名', 'Tên truyện'],
    ['最新章节', 'Chương mới nhất'], ['作者', 'Tác giả'], ['更新时间', 'Thời gian cập nhật'],
    ['帮助中心', 'Trung tâm trợ giúp'], ['作家助手', 'Trợ lý tác giả'],
    ['读者：', 'Độc giả:'], ['分类：', 'Thể loại:'], ['状态：', 'Trạng thái:'], ['字数：', 'Độ dài:'],
    ['全部', 'Tất cả'], ['男生', 'Nam'], ['女生', 'Nữ'],
    ['主题', 'Chủ đề'], ['角色', 'Nhân vật'], ['情节', 'Tình tiết'],
    ['已完结', 'Đã hoàn thành'], ['连载中', 'Đang ra chương'],
    ['30万以下', 'Dưới 300.000 chữ'], ['30-50万', '300.000–500.000 chữ'],
    ['50-100万', '500.000–1 triệu chữ'], ['100-200万', '1–2 triệu chữ'], ['200万以上', 'Trên 2 triệu chữ'],
    ['最热', 'Phổ biến nhất'], ['最新', 'Mới nhất'], ['字数', 'Độ dài'],
    ['开始阅读', 'Bắt đầu đọc'], ['目录', 'Mục lục'], ['加书架', 'Thêm vào tủ sách'],
    ['夜间', 'Chế độ tối'], ['字号', 'Cỡ chữ'], ['下载', 'Tải xuống'], ['领红包', 'Nhận thưởng'],
    ['番茄小说网', 'Fanqie Novel'], ['作家课堂', 'Lớp học tác giả'],
    ['验证码登录', 'Đăng nhập bằng mã xác minh'], ['扫码登录', 'Đăng nhập bằng QR'],
    ['密码登录', 'Đăng nhập bằng mật khẩu'], ['登录/注册', 'Đăng nhập/Đăng ký'],
    ['手机号', 'Số điện thoại'], ['请输入手机号/邮箱', 'Nhập số điện thoại/email'],
    ['请输入密码', 'Nhập mật khẩu'], ['请输入验证码', 'Nhập mã xác minh'],
    ['请输入正确的手机号', 'Vui lòng nhập số điện thoại hợp lệ'],
    ['获取验证码', 'Lấy mã xác minh'], ['我已阅读并同意', 'Tôi đã đọc và đồng ý với'],
    ['用户协议', 'Điều khoản sử dụng'], ['隐私政策', 'Chính sách quyền riêng tư'],
    ['平台宝典', 'Cẩm nang nền tảng'], ['新手专区', 'Dành cho người mới'],
    ['品类指南', 'Hướng dẫn thể loại'], ['写作技巧', 'Kỹ thuật viết'],
    ['大神专访', 'Phỏng vấn tác giả nổi tiếng'],
    ['版权改编', 'Chuyển thể tác phẩm'], ['番茄出版', 'Xuất bản Fanqie'],
    ['网文签约', 'Ký hợp đồng truyện mạng'], ['独家分成签约', 'Hợp đồng độc quyền chia doanh thu'],
    ['优质保底签约', 'Hợp đồng có mức thu nhập bảo đảm'],
    ['适用对象：', 'Áp dụng cho:'], ['分成收益：', 'Thu nhập chia doanh thu:'],
    ['礼物收益：', 'Thu nhập từ quà tặng:'], ['版权收益：', 'Thu nhập bản quyền:'],
    ['保底/买断收益：', 'Thu nhập bảo đảm/mua đứt:'],
    ['礼物打赏收益：', 'Thu nhập từ quà tặng độc giả:'], ['稿费分成收益：', 'Nhuận bút chia doanh thu:'],
    ['《番茄小说网用户协议》', 'Điều khoản sử dụng Fanqie Novel'],
    ['《番茄小说网隐私政策》', 'Chính sách quyền riêng tư Fanqie Novel'],
    ['营业执照', 'Giấy phép kinh doanh'], ['出版物经营许可证', 'Giấy phép kinh doanh xuất bản phẩm'],
    ['广播电视节目制作经营许可证', 'Giấy phép sản xuất chương trình phát thanh, truyền hình'],
    ['中国互联网举报中心', 'Trung tâm báo cáo vi phạm Internet Trung Quốc'],
    ['站点地图', 'Sơ đồ website'],
    ['打开微信扫码关注微信公众号', 'Mở WeChat, quét QR để theo dõi kênh chính thức'],
    ['打开抖音扫码关注官方帐号', 'Mở Douyin, quét QR để theo dõi tài khoản chính thức']
  ].map(([source, vietnamese]) => Object.freeze({ source, vietnamese }));
  // Shared by the content script and its narrow language-storage broker.
  const allowedPath = path => /^\/$|^\/(library|rank|welfare)\/?$|^\/(page|reader)\/\d+\/?$|^\/main\/writer\/login\/?$|^\/writer\/zone(?:\/[a-zA-Z0-9_-]+)*\/?$/.test(path);
  return Object.freeze({ version: 2, entries: Object.freeze(entries), allowedPath });
});
