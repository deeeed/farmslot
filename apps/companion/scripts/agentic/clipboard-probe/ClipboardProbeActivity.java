package net.siteed.farmslot.viewlinkprobe.development;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.os.Bundle;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Test-only foreground reader. It cannot write the clipboard or access Companion state. */
public final class ClipboardProbeActivity extends Activity {
  private boolean read;

  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    TextView label = new TextView(this);
    label.setText("Reading the copied view link for validation");
    setContentView(label);
  }

  @Override public void onWindowFocusChanged(boolean focused) {
    super.onWindowFocusChanged(focused);
    if (!focused || read) return;
    read = true;
    String requestId = getIntent().getStringExtra("requestId");
    if (requestId == null || !requestId.matches("[a-zA-Z0-9-]{16,64}")) {
      finish();
      return;
    }
    JSONObject result = new JSONObject();
    try {
      ClipboardManager manager = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
      ClipData clip = manager.getPrimaryClip();
      result.put("requestId", requestId);
      result.put("readAt", System.currentTimeMillis());
      result.put("itemCount", clip == null ? 0 : clip.getItemCount());
      if (clip == null || clip.getItemCount() != 1) {
        result.put("status", "missing");
      } else {
        result.put("status", "read");
        result.put("text", clip.getItemAt(0).coerceToText(this).toString());
      }
      File file = new File(getFilesDir(), "clipboard-" + requestId + ".json");
      if (!file.createNewFile()) throw new IllegalStateException("Refuse an existing observation");
      try (FileOutputStream output = new FileOutputStream(file)) {
        output.write(result.toString().getBytes(StandardCharsets.UTF_8));
        output.getFD().sync();
      }
    } catch (Exception error) {
      throw new IllegalStateException("System clipboard observation failed", error);
    } finally {
      finish();
    }
  }
}
