export default `<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2>🎉 您的订单已完成，卡密发放成功</h2>
  <p>订单编号：{{orderNo}}</p>
  <p>商品名称：{{productName}}</p>
  <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 15px 0;">
    <p style="margin: 0;"><strong>账号：</strong>{{accountLabel}}</p>
    <p style="margin: 5px 0 0 0;"><strong>密码/密钥：</strong>{{deliverySecret}}</p>
    {{#if deliveryNote}}<p style="margin: 5px 0 0 0;"><strong>备注：</strong>{{deliveryNote}}</p>{{/if}}
  </div>
  {{#if additionalDeliveries}}<div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 15px 0;">
    <p style="margin: 0 0 8px 0;"><strong>其余卡密：</strong></p>
    <pre style="margin: 0; white-space: pre-wrap; font-family: sans-serif;">{{additionalDeliveries}}</pre>
  </div>{{/if}}
  <p style="color: #888; font-size: 12px;">请妥善保管您的卡密信息，勿泄露给他人。</p>
</body>
</html>`;
