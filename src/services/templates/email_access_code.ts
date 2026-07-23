export default `<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2>邮箱验证码</h2>
  <p>您正在查询订单或使用账户余额。</p>
  <div style="font-size: 28px; font-weight: 700; letter-spacing: 6px; margin: 20px 0;">{{code}}</div>
  <p>验证码最长在 {{expiresInMinutes}} 分钟内有效。请勿向他人泄露。</p>
  <p style="color: #888; font-size: 12px;">如果不是您本人操作，请忽略此邮件。</p>
</body>
</html>`;
