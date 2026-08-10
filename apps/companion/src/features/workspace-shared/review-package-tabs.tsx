import { createContext, type ReactNode, useContext } from 'react';

export type ReviewPackageContentTab = 'diff' | 'evidence' | 'timeline';

const ReviewPackageTabsContext = createContext<ReviewPackageContentTab | null>(null);

export function ReviewPackageTabProvider({
  children,
  tab,
}: {
  children: ReactNode;
  tab: ReviewPackageContentTab;
}) {
  return (
    <ReviewPackageTabsContext.Provider value={tab}>{children}</ReviewPackageTabsContext.Provider>
  );
}

export function useReviewPackageTab(): ReviewPackageContentTab | null {
  return useContext(ReviewPackageTabsContext);
}
