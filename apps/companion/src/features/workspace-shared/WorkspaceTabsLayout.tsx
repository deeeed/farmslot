import { type Href, useNavigation, useRouter } from 'expo-router';
import { TabList, Tabs, TabSlot, TabTrigger, type TabTriggerSlotProps } from 'expo-router/ui';
import { forwardRef, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, fonts, spacing } from '../../lib/theme';

export interface WorkspaceTabDefinition {
  href: Href;
  label: string;
  name: string;
  testID: string;
}

export function WorkspaceTabsLayout({
  fallbackHref,
  tabs,
  title,
}: {
  fallbackHref: Href;
  tabs: WorkspaceTabDefinition[];
  title: string;
}) {
  const navigation = useNavigation();
  const router = useRouter();

  const exitWorkspace = () => {
    const parent = navigation.getParent();
    if (parent?.canGoBack()) {
      parent.goBack();
      return;
    }
    router.replace(fallbackHref);
  };

  return (
    <View style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.header}>
        <Pressable
          accessibilityLabel="Go back"
          accessibilityRole="button"
          hitSlop={12}
          style={styles.backButton}
          onPress={exitWorkspace}
        >
          <Text style={styles.backLabel}>‹ Back</Text>
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {title}
        </Text>
      </SafeAreaView>
      <Tabs options={{ backBehavior: 'none' }} style={styles.tabs}>
        <TabList style={styles.tabList}>
          {tabs.map((tab) => (
            <TabTrigger key={tab.name} asChild href={tab.href} name={tab.name}>
              <WorkspaceTab testID={tab.testID}>{tab.label}</WorkspaceTab>
            </TabTrigger>
          ))}
        </TabList>
        <TabSlot style={styles.content} />
      </Tabs>
    </View>
  );
}

interface WorkspaceTabProps extends TabTriggerSlotProps {
  children: ReactNode;
}

const WorkspaceTab = forwardRef<View, WorkspaceTabProps>(function WorkspaceTab(
  { children, isFocused, style: _style, ...props },
  ref,
) {
  return (
    <Pressable
      {...props}
      ref={ref}
      accessibilityRole="tab"
      accessibilityState={{ selected: isFocused }}
      style={[styles.tab, isFocused && styles.tabActive]}
    >
      <Text style={[styles.tabLabel, isFocused && styles.tabLabelActive]}>{children}</Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bgBase,
    flex: 1,
  },
  content: {
    flex: 1,
  },
  backButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  backLabel: {
    color: colors.accent,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  header: {
    alignItems: 'center',
    backgroundColor: colors.bgSurface,
    flexDirection: 'row',
    minHeight: 48,
    paddingBottom: spacing.sm,
    paddingRight: 64,
  },
  headerTitle: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    minWidth: 0,
  },
  tabs: {
    flex: 1,
  },
  tabList: {
    backgroundColor: colors.bgSurface,
    borderBottomColor: colors.bgCardHover,
    borderBottomWidth: 1,
    flexDirection: 'row',
    paddingRight: 64,
  },
  tab: {
    alignItems: 'center',
    borderBottomColor: 'transparent',
    borderBottomWidth: 2,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  tabActive: {
    backgroundColor: colors.accent + '12',
    borderBottomColor: colors.accent,
  },
  tabLabel: {
    color: colors.accentHover,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  tabLabelActive: {
    color: colors.textPrimary,
  },
});
