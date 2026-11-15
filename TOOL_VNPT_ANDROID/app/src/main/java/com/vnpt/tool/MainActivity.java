package com.vnpt.tool;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ConsoleMessage;

public class MainActivity extends Activity {
    private WebView web;
    private WebBridge bridge;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        web.setBackgroundColor(0xFFF3F5F8);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(true);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setJavaScriptCanOpenWindowsAutomatically(false);
        web.getSettings().setSupportMultipleWindows(false);
        web.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                injectDiagnosticButton(view);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                return !url.startsWith("file:///android_asset/");
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return !url.startsWith("file:///android_asset/");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage message) {
                if (bridge != null) bridge.logFromJs(message.messageLevel().name(),
                        message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
                return true;
            }
        });
        bridge = new WebBridge(web);
        web.addJavascriptInterface(bridge, "AndroidBridge");
        setContentView(web);
        web.loadUrl("file:///android_asset/index.html");
    }

    private void injectDiagnosticButton(WebView view) {
        String js = "(function(){function ensure(){if(document.getElementById('vnptDiagBtn')||!document.body)return;"
          + "var b=document.createElement('button');b.id='vnptDiagBtn';b.textContent='📋 Nhật ký';"
          + "b.style='position:fixed;right:10px;bottom:10px;z-index:2147483647;padding:10px 13px;background:#243447;color:white;border:0;border-radius:8px;font-size:13px;';"
          + "b.onclick=function(){var old=document.getElementById('vnptDiagBox');if(old){old.remove();return;}"
          + "var box=document.createElement('div');box.id='vnptDiagBox';box.style='position:fixed;inset:5% 3%;z-index:2147483647;background:#fff;border:2px solid #243447;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px;';"
          + "var bar=document.createElement('div');bar.style='display:flex;gap:6px;flex-wrap:wrap';"
          + "var area=document.createElement('textarea');area.readOnly=true;area.style='flex:1;width:100%;font:12px monospace;white-space:pre;';"
          + "area.value=AndroidBridge.diagnosticLog();"
          + "function btn(t,f){var x=document.createElement('button');x.textContent=t;x.onclick=f;bar.appendChild(x);}"
          + "btn('Làm mới',function(){area.value=AndroidBridge.diagnosticLog();});"
          + "btn('Sao chép',function(){area.select();document.execCommand('copy');alert('Đã sao chép nhật ký');});"
          + "btn('Xóa nhật ký',function(){if(confirm('Xóa toàn bộ nhật ký?')){AndroidBridge.clearDiagnosticLog();area.value=AndroidBridge.diagnosticLog();}});"
          + "btn('Đóng',function(){box.remove();});box.appendChild(bar);box.appendChild(area);document.body.appendChild(box);};document.body.appendChild(b);};ensure();setInterval(ensure,1000);})();";
        view.evaluateJavascript(js, null);
    }

    @Override public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        if (bridge != null) bridge.close();
        if (web != null) { web.stopLoading(); web.removeJavascriptInterface("AndroidBridge"); web.destroy(); }
        super.onDestroy();
    }
}
