import { Platform, Text, type TextProps } from 'react-native';

import { taskTitleText } from '@farmslot/protocol';

interface RunTitleProps extends Omit<TextProps, 'children'> {
  title: string;
}
interface HoverTitleNode {
  setAttribute?: (name: string, value: string) => void;
}

export function RunTitle({ title, ...props }: RunTitleProps) {
  const fullTitle = taskTitleText(title, Infinity);
  return (
    <Text
      {...props}
      numberOfLines={2}
      accessibilityLabel={fullTitle}
      ref={(node) => {
        if (Platform.OS === 'web') {
          (node as unknown as HoverTitleNode | null)?.setAttribute?.('title', fullTitle);
        }
      }}
    >
      {taskTitleText(title)}
    </Text>
  );
}
