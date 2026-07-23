export default `<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2>⚠️ 库存预警通知</h2>
  <p>以下商品库存已低于预警阈值，请及时补货：</p>
  <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
    <thead>
      <tr style="background: #f5f5f5;">
        <th style="text-align: left; padding: 8px; border-bottom: 1px solid #ddd;">商品</th>
        <th style="text-align: left; padding: 8px; border-bottom: 1px solid #ddd;">ID</th>
        <th style="text-align: right; padding: 8px; border-bottom: 1px solid #ddd;">剩余库存</th>
        <th style="text-align: right; padding: 8px; border-bottom: 1px solid #ddd;">预警阈值</th>
      </tr>
    </thead>
    <tbody>
      {{productsTable}}
    </tbody>
  </table>
  <p style="color: #888; font-size: 12px;">请登录后台及时处理，避免缺货影响销售。</p>
</body>
</html>`;
