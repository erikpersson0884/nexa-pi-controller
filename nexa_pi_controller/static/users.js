const createAccountButton = document.getElementById('open-create-account');
const createAccountDialog = document.getElementById('create-account-dialog');

if (createAccountButton && createAccountDialog) {
  const openDialog = () => {
    if (!createAccountDialog.open) createAccountDialog.showModal();
  };
  createAccountButton.addEventListener('click', openDialog);

  if (new URLSearchParams(window.location.search).get('create') === '1') {
    openDialog();
  }
}

const closeUserMenus = () => {
  document.querySelectorAll('.user-menu-toggle').forEach(toggle => {
    const menu = document.getElementById(toggle.getAttribute('aria-controls'));
    if (menu) menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  });
};

document.querySelectorAll('.user-menu-toggle').forEach(toggle => {
  const menu = document.getElementById(toggle.getAttribute('aria-controls'));
  if (!menu) return;

  toggle.addEventListener('click', () => {
    const shouldOpen = menu.hidden;
    closeUserMenus();
    menu.hidden = !shouldOpen;
    toggle.setAttribute('aria-expanded', String(shouldOpen));
  });
});

document.querySelectorAll('.user-reset-trigger').forEach(button => {
  button.addEventListener('click', () => {
    closeUserMenus();
    const dialog = document.getElementById(button.dataset.dialog);
    if (dialog && !dialog.open) dialog.showModal();
  });
});

document.querySelectorAll('.user-role-select').forEach(select => {
  select.addEventListener('change', () => select.form.requestSubmit());
});

document.addEventListener('click', event => {
  if (!event.target.closest('.user-card-menu')) closeUserMenus();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeUserMenus();
});
