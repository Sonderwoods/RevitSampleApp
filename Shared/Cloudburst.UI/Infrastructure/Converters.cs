using System;
using System.Collections;
using System.Globalization;
using System.Windows;
using System.Windows.Data;

namespace Cloudburst.UI.Infrastructure
{
    /// <summary>true → Visible (Invert: true → Collapsed).</summary>
    public sealed class BoolToVisibilityConverter : IValueConverter
    {
        public bool Invert { get; set; }
        public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
        {
            bool b = value is bool v && v;
            return (b ^ Invert) ? Visibility.Visible : Visibility.Collapsed;
        }
        public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => Binding.DoNothing;
    }

    /// <summary>null / empty string / empty collection / 0 → Collapsed (Invert flips).</summary>
    public sealed class HasValueToVisibilityConverter : IValueConverter
    {
        public bool Invert { get; set; }
        public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
        {
            bool has = value switch
            {
                null => false,
                string s => s.Length > 0,
                ICollection c => c.Count > 0,
                int i => i != 0,
                double d => d != 0,
                bool b => b,
                _ => true
            };
            return (has ^ Invert) ? Visibility.Visible : Visibility.Collapsed;
        }
        public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => Binding.DoNothing;
    }

    /// <summary>int == parameter → true; ConvertBack true → parameter (false → DoNothing). Used for segmented radio buttons.</summary>
    public sealed class IntEqualsConverter : IValueConverter
    {
        public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
        {
            try
            {
                bool eq = value != null && parameter != null && System.Convert.ToInt32(value, CultureInfo.InvariantCulture) == System.Convert.ToInt32(parameter, CultureInfo.InvariantCulture);
                if (targetType == typeof(Visibility)) return eq ? Visibility.Visible : Visibility.Collapsed;
                return eq;
            }
            catch (Exception) { return targetType == typeof(Visibility) ? Visibility.Collapsed : (object)false; }
        }

        public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        {
            try { return value is bool b && b ? System.Convert.ToInt32(parameter, CultureInfo.InvariantCulture) : Binding.DoNothing; }
            catch (Exception) { return Binding.DoNothing; }
        }
    }

    /// <summary>bool → opacity (true 1, false <see cref="Off"/>).</summary>
    public sealed class BoolToOpacityConverter : IValueConverter
    {
        public double Off { get; set; } = 0.45;
        public object Convert(object value, Type targetType, object parameter, CultureInfo culture) => value is bool b && b ? 1.0 : Off;
        public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => Binding.DoNothing;
    }

    public sealed class NotConverter : IValueConverter
    {
        public object Convert(object value, Type targetType, object parameter, CultureInfo culture) => !(value is bool b && b);
        public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => !(value is bool b && b);
    }
}
