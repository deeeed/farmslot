import React, { useContext } from 'react';
import {
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView from 'react-native-webview';

import { RecipeHudContext } from '../farmslot/RecipeBridgeProvider';
import { RecipeHud } from '../farmslot/RecipeHud';
import { formatDocument } from '../lib/document-format';
import { isolatedReportHtml, REPORT_DOCUMENT_BASE, reportNavigation } from '../lib/document-html';
import { colors, fonts, radii, spacing } from '../lib/theme';

export interface DocumentHtmlLinks {
  /** A report-relative link to the retained artifact path it names, or null. */
  resolveArtifact: (relativeHref: string) => string | null;
  openArtifact: (artifactPath: string) => void;
}

export function DocumentViewer({
  visible,
  title,
  body,
  html,
  onClose,
  children,
}: {
  children?: React.ReactNode;
  visible: boolean;
  title: string;
  body: string;
  /** Render the body as an isolated HTML page (a QA run's report.html) instead of formatted text. */
  html?: DocumentHtmlLinks;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const recipeHud = useContext(RecipeHudContext);
  const { width, height } = useWindowDimensions();
  const topInset = Math.max(
    insets.top,
    Platform.OS === 'ios' ? 54 : (StatusBar.currentHeight ?? 0),
  );
  const bottomInset = Math.max(insets.bottom, Platform.OS === 'ios' ? 10 : 0);
  const formatted = html ? [] : formatDocument(title, body);
  const minCodeWidth = Math.max(320, width - spacing.xl * 2);
  if (!visible) return null;
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View
        style={[
          styles.container,
          {
            paddingTop: topInset,
            paddingBottom: bottomInset,
          },
        ]}
      >
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Pressable style={styles.closeButton} onPress={onClose}>
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>
        <ScrollView
          testID="companion-document-body"
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
        >
          {html && body.trim() ? (
            <WebView
              testID="companion-document-html"
              source={{ html: isolatedReportHtml(body), baseUrl: REPORT_DOCUMENT_BASE }}
              // Every URL reaches the decision below; none falls through to the system opener.
              originWhitelist={['*']}
              javaScriptEnabled={false}
              setSupportMultipleWindows={false}
              nestedScrollEnabled
              onShouldStartLoadWithRequest={(request) => {
                // Android reports every navigation as `other`; with scripts off and refresh
                // redirects removed, a page navigation there can only come from a tap.
                const tapped =
                  request.isTopFrame !== false &&
                  (Platform.OS === 'android' || request.navigationType === 'click');
                const next = reportNavigation(request.url, html.resolveArtifact, tapped);
                if (next.kind === 'document') return true;
                if (next.kind === 'artifact') html.openArtifact(next.path);
                if (next.kind === 'external') void Linking.openURL(next.url);
                return false;
              }}
              style={[styles.htmlPage, { height: Math.round(height * 0.7) }]}
            />
          ) : formatted.length > 0 ? (
            formatted.map((block, index) =>
              block.kind === 'separator' ? (
                <View key={`${block.kind}-${index}`} style={styles.separator} />
              ) : block.kind === 'code' || block.kind === 'json' || block.kind === 'table' ? (
                <ScrollView
                  key={`${block.kind}-${index}`}
                  horizontal
                  showsHorizontalScrollIndicator
                  style={styles.codeScroller}
                  contentContainerStyle={styles.codeScrollerContent}
                >
                  <Text
                    selectable
                    style={[styles.documentText, styles[block.kind], { minWidth: minCodeWidth }]}
                  >
                    {block.text}
                  </Text>
                </ScrollView>
              ) : (
                <Text
                  key={`${block.kind}-${index}`}
                  selectable
                  style={[styles.documentText, styles[block.kind]]}
                >
                  {block.text}
                </Text>
              ),
            )
          ) : (
            <Text style={styles.documentText}>No document content</Text>
          )}
          <Pressable
            testID="companion-document-end"
            style={styles.footerCloseButton}
            onPress={onClose}
          >
            <Text style={styles.closeText}>Close document</Text>
          </Pressable>
          {children}
        </ScrollView>
        {/* Android dialogs are separate windows; the root HUD cannot cover them. */}
        {Platform.OS === 'android' && <RecipeHud state={recipeHud} />}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  htmlPage: {
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    backgroundColor: colors.bgSurface,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgCard,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '700',
    flex: 1,
    marginRight: spacing.lg,
  },
  closeButton: {
    borderRadius: radii.md,
    backgroundColor: colors.accent + '25',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  closeText: {
    color: colors.accent,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: spacing.xl,
    paddingBottom: spacing.xxxl,
  },
  documentText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
  paragraph: {
    color: colors.textPrimary,
  },
  heading: {
    color: colors.accent,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    marginTop: spacing.lg,
  },
  bullet: {
    color: colors.textSecondary,
    paddingLeft: spacing.md,
  },
  numbered: {
    color: colors.textSecondary,
    paddingLeft: spacing.md,
  },
  quote: {
    borderLeftColor: colors.accent + '66',
    borderLeftWidth: 3,
    color: colors.textSecondary,
    paddingLeft: spacing.md,
  },
  separator: {
    backgroundColor: colors.bgCard,
    height: 1,
    marginBottom: spacing.md,
    marginTop: spacing.sm,
  },
  table: {
    color: colors.textPrimary,
    fontFamily: 'Menlo',
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  code: {
    color: colors.textPrimary,
    fontFamily: 'Menlo',
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  json: {
    color: colors.textPrimary,
    fontFamily: 'Menlo',
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    padding: spacing.md,
    lineHeight: 18,
  },
  codeScroller: {
    marginBottom: spacing.sm,
  },
  codeScrollerContent: {
    paddingRight: spacing.lg,
  },
  footerCloseButton: {
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: colors.accent + '25',
    borderColor: colors.accent + '55',
    borderRadius: radii.md,
    borderWidth: 1,
    marginTop: spacing.xl,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
});
