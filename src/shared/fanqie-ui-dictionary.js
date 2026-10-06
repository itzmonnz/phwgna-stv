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
    ['夜间', 'Chế độ tối'], ['字号', 'Cỡ chữ'], ['下载', 'Tải xuống'], ['领红包', 'Nhận thưởng']
  ].map(([source, vietnamese]) => Object.freeze({ source, vietnamese }));
  return Object.freeze({ version: 1, entries: Object.freeze(entries) });
});
