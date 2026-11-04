import {
  type Href,
  type NativeStackNavigationProp,
  useIsFocused,
  useLocalSearchParams,
  useNavigation,
  useRouter,
  useSegments,
} from 'expo-router';
import {
  type ComponentType,
  createContext,
  type PropsWithChildren,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { Platform } from 'react-native';

import {
  createViewStateContext,
  selectedViewStateParams,
  type ViewStateContext,
  type ViewStateField,
  type ViewStateHistory,
  viewStateRoutePatch,
  viewStateSearchParams,
  viewToggleField,
} from '@farmslot/protocol';

import { bindViewStateFilters } from './view-state-filters';

const ViewState = createContext<ViewStateContext | undefined>(undefined);

/** Each screen owns one local route context, shared by all of its display controls. */
export function ViewStateProvider({ children }: PropsWithChildren) {
  const params = useLocalSearchParams();
  const focused = useIsFocused();
  const stopFilters = useRef<(() => void) | undefined>(undefined);
  const segments = useSegments();
  const router = useRouter();
  const navigation =
    useNavigation<
      Pick<
        NativeStackNavigationProp<Record<string, Record<string, string | string[] | undefined>>>,
        'setParams'
      >
    >();
  const incoming = viewStateSearchParams(params);
  const source = incoming.toString();
  const current = useRef({ source, params: incoming });
  const listeners = useRef(new Set<() => void>());
  const routePattern = useRef(`/${segments.join('/')}`);
  routePattern.current = `/${segments.join('/')}`;
  if (current.current.source !== source) current.current = { source, params: incoming };
  const state = useMemo(
    () =>
      createViewStateContext({
        read: () => new URLSearchParams(current.current.params),
        write(next, history) {
          const patch = viewStateRoutePatch(current.current.params, next);
          current.current.params = next;
          // Native Back returns to the screen with its selected options. Web choices
          // also get browser history entries; typing replaces the current entry.
          if (Platform.OS === 'web' && history === 'push')
            router.push({
              pathname: routePattern.current,
              params: viewStateRoutePatch(new URLSearchParams(), next),
            });
          else navigation.setParams(patch);
          for (const listener of listeners.current) listener();
        },
        subscribe(listener) {
          listeners.current.add(listener);
          return () => listeners.current.delete(listener);
        },
      }),
    [router, navigation, source],
  );
  useLayoutEffect(() => {
    if (!focused) return;
    stopFilters.current?.();
    stopFilters.current = bindViewStateFilters(state);
  }, [focused, state]);
  useEffect(() => () => stopFilters.current?.(), []);
  return <ViewState.Provider value={state}>{children}</ViewState.Provider>;
}

export function useViewState(): ViewStateContext {
  const state = useContext(ViewState);
  if (!state) throw new Error('Display choices need their screen ViewStateProvider');
  useSyncExternalStore(state.subscribe, state.snapshot, state.snapshot);
  return state;
}

/** Route files stay thin while the provider sits inside their local Expo route scope. */
export function withViewState<P extends object>(Screen: ComponentType<P>): ComponentType<P> {
  return function ViewStateScreen(props: P) {
    return (
      <ViewStateProvider>
        <Screen {...props} />
      </ViewStateProvider>
    );
  };
}

export function useViewChoice<T>(
  field: ViewStateField<T>,
  history: ViewStateHistory = 'push',
): readonly [T, (value: SetStateAction<T>) => void] {
  const state = useViewState();
  const set = useCallback(
    (next: SetStateAction<T>) => {
      state.set(
        field,
        typeof next === 'function' ? (next as (current: T) => T)(state.get(field)) : next,
        history,
      );
    },
    [state, field, history],
  );
  return [state.get(field), set];
}
export function useViewToggle(id: string, defaultValue = false) {
  return useViewChoice(viewToggleField('panels', id, defaultValue));
}

/** The headless tab navigator rebuilds destinations from these hrefs after param changes. */
export function viewStateHref(
  href: Href,
  params: Readonly<Record<string, string | readonly string[] | undefined>>,
): Href {
  return typeof href === 'object'
    ? { ...href, params: { ...selectedViewStateParams(params), ...href.params } }
    : href;
}
