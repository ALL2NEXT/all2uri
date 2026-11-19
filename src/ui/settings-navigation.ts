import { dom } from "./dom.ts";

export function createSettingsNavigation(
  renderColumnVisibilityOptions: () => void,
) {
  function filterSettingsHome() {
    const query = dom.settingsHomeSearch.value.trim().toLocaleLowerCase();
    let visibleCount = 0;
    for (const card of dom.settingsTabs) {
      const matches =
        card.textContent?.toLocaleLowerCase().includes(query) ?? false;
      card.hidden = !matches;
      if (matches) visibleCount += 1;
    }
    dom.settingsHomeEmpty.hidden = visibleCount > 0;
  }

  function filterSettingsSubnav() {
    const query = dom.settingsDetailSearch.value.trim().toLocaleLowerCase();
    for (const button of dom.settingsSubnavButtons) {
      const parent = button.closest<HTMLElement>("[data-settings-subnav]");
      const matches =
        parent !== null &&
        !parent.hidden &&
        (button.textContent?.toLocaleLowerCase().includes(query) ?? false);
      button.hidden = !matches;
    }
  }

  function showSettingsContent(category: string, button: HTMLButtonElement) {
    const pane = dom.settingsPanes.find(
      (candidate) => candidate.dataset.settingsPane === category,
    );
    if (!pane) return;
    const selectedContent = button.dataset.settingsAnchor;
    for (const content of pane.querySelectorAll<HTMLElement>(
      "[data-settings-content]",
    )) {
      content.hidden = content.dataset.settingsContent !== selectedContent;
    }
    dom.settingsContent.scrollTop = 0;
  }

  function selectSettingsCategory(category: string) {
    if (
      !dom.settingsPanes.some((pane) => pane.dataset.settingsPane === category)
    )
      return;
    dom.settingsHome.hidden = true;
    dom.settingsDetail.hidden = false;
    for (const tab of dom.settingsTabs) {
      const selected = tab.dataset.settingsTab === category;
      tab.setAttribute("aria-pressed", String(selected));
    }
    for (const pane of dom.settingsPanes)
      pane.hidden = pane.dataset.settingsPane !== category;
    for (const subnav of dom.settingsSubnavs)
      subnav.hidden = subnav.dataset.settingsSubnav !== category;
    dom.settingsDetailSearch.value = "";
    filterSettingsSubnav();
    if (category === "list") renderColumnVisibilityOptions();
    dom.settingsContent.scrollTop = 0;

    const firstButton = dom.settingsSubnavButtons.find(
      (button) =>
        button.closest<HTMLElement>("[data-settings-subnav]")?.dataset
          .settingsSubnav === category,
    );
    for (const button of dom.settingsSubnavButtons)
      button.removeAttribute("aria-current");
    if (!firstButton) return;
    firstButton.setAttribute("aria-current", "location");
    showSettingsContent(category, firstButton);
    firstButton.focus({ preventScroll: true });
  }

  function showSettingsHome() {
    dom.settingsHome.hidden = false;
    dom.settingsDetail.hidden = true;
    dom.settingsHomeSearch.value = "";
    dom.settingsDetailSearch.value = "";
    filterSettingsHome();
    for (const tab of dom.settingsTabs)
      tab.setAttribute("aria-pressed", "false");
    for (const button of dom.settingsSubnavButtons)
      button.removeAttribute("aria-current");
  }

  function navigateSettingsAnchor(button: HTMLButtonElement) {
    const target = document.getElementById(button.dataset.settingsAnchor ?? "");
    if (!target) return;
    for (const candidate of dom.settingsSubnavButtons)
      candidate.removeAttribute("aria-current");
    button.setAttribute("aria-current", "location");

    const category = button.closest<HTMLElement>("[data-settings-subnav]")
      ?.dataset.settingsSubnav;
    if (category) showSettingsContent(category, button);
  }

  return {
    selectSettingsCategory,
    showSettingsHome,
    filterSettingsHome,
    filterSettingsSubnav,
    navigateSettingsAnchor,
  };
}
